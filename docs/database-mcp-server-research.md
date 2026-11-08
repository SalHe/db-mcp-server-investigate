# 数据库 MCP Server 能力与权限边界调研

**调研时间**：2026-11  
**调研对象**：30+ 个数据库/数据平台 MCP Server（官方实现为主，含代表性社区实现）  
**方法**：官方仓库源码 + 官方文档 + 本地可复现实测  
**证据标记**：`[文档]` 官方文档/README；`[源码]` 官方仓库源码；`[实验]` 本文实测；`[推断]` 基于以上材料的归纳

> **一句话结论**：数据库 MCP Server 的安全边界不是"把 SQL 关键字过滤掉"，而是 **工具面裁剪（暴露什么）+ 访问模式（读/写）+ SQL 执行策略 + 数据库角色权限 + 资源上限** 的叠加。Agent 端的权限确认只是交互层护栏，不能替代数据库侧的最小权限。

---

## 0. 摘要

1. **默认姿态正在分化，但"默认只读"是明显趋势。** ClickHouse、AWS 数据库系列、MariaDB、CockroachDB、YugabyteDB、MotherDuck 默认只读；Supabase、Neon、MongoDB 默认允许写（但官方示例常带 `--readOnly`）；TiDB、OceanBase、Redis 基本不做访问模式限制。`[文档]`
2. **只读的实现层次差异极大，安全性也完全不同。** 最弱的是 SQL 文本正则/关键字匹配（AWS MySQL 官方自己承认是 best-effort，不是安全边界）；较强的是"只读事务 + 只读数据库角色"；最强的是"不注册写工具 + 只读事务 + 最小权限角色"三层叠加。
3. **工具面裁剪比运行时拦截更安全。** MongoDB 的 `--readOnly` 直接不注册写工具；Neo4j 的 `--read-only` 不注册 `write_neo4j_cypher`；Supabase 用 feature groups 把 36 个工具缩到 5 个。模型看不到的工具，比"看得到但会被拒绝"的工具更难被诱导调用。
4. **官方参考实现 `@modelcontextprotocol/server-postgres` 不可用于生产。** 它在 npm 上已被标记 deprecated，且其"只读"实现可以被 `COMMIT; DROP TABLE ...` 绕过。本文实验复现了该绕过；同时证明**数据库只读角色**能把破坏拦住。`[实验 E1/E2]`
5. **权限是分层收敛的，不是单点开关。** 一次调用同时经过：客户端工具审批 → MCP 传输认证 → MCP Server 的 scope/feature/access-mode → SQL 策略 → 数据库角色/RLS → 资源与审计。任何一层都不能单独承担安全责任。
6. **"能读"不等于"无害"。** 只读 Agent 仍可做全表扫描、`pg_sleep`、读取敏感列、把数据导出；必须配行数/字节/超时/并发限制，以及列级脱敏、RLS、只读副本。
7. **提示注入是数据库 MCP 的固有风险。** 数据库里的内容（行、注释、日志）会进入模型上下文；恶意内容可以诱导模型调用被允许的写工具。只读默认、工具白名单、结果标记为不可信数据，比"让模型自觉"可靠。
8. **对数据库内核 MCP Server 的建议**：默认只读；把内核能力拆成**语义化工具**（plan/stats/locks/index advisor），而不是只给一个 `execute_sql`；写/DDL/运维分成独立工具与独立凭据；SQL 策略 fail-closed；数据库角色是最终边界；HTTP 部署用 OAuth 2.1 + 每用户身份映射。

---

## 1. 调研范围与方法

### 1.1 覆盖的服务器

| 类别 | 服务器 |
|---|---|
| 官方参考/已归档 | `@modelcontextprotocol/server-postgres`、`server-sqlite` |
| 通用网关 | DBHub (Bytebase) |
| PostgreSQL 增强 | Postgres MCP Pro (Crystal DBA)、Google MCP Toolbox |
| 托管数据库 | Supabase MCP、Neon MCP |
| 数仓/分析 | ClickHouse MCP、Snowflake 托管 MCP、Databricks 托管 MCP、BigQuery (Toolbox) |
| 云厂商 | AWS Labs: postgres / mysql / mssql / aurora-dsql / documentdb / dynamodb |
| 商业数据库 | Oracle SQLcl MCP、Oracle Database MCP Toolkit、Microsoft SQL MCP (DAB) |
| 国产数据库 | TiDB (PyTiDB)、OceanBase、PolarDB (MySQL/PostgreSQL/OpenAPI) |
| NoSQL/检索/图 | MongoDB、Redis、Neo4j、Elasticsearch、Milvus、Qdrant |
| 其他关系型 | MariaDB、CockroachDB、YugabyteDB、MotherDuck/DuckDB |
| 社区实现（对比用） | `@benborla29/mcp-server-mysql` 等 |

### 1.2 一手来源

- 每个服务器的官方 GitHub 仓库 README、源码、官方文档站；
- MCP 规范与安全最佳实践（modelcontextprotocol.io）；
- 客户端权限文档（Claude Code 等）；
- 不采用 toolradar / agentindex 等内容农场的结论，只把它们当作"线索来源"。

### 1.3 实验环境

- PostgreSQL 16（Docker，端口 55432，库 `testdb`，100 行 `users`、500 行 `orders`）；
- Node.js 25 + `@modelcontextprotocol/sdk`；自写 raw JSON-RPC 探针，绕过 SDK 对返回值的校验，直接观察 `tools/list` / `tools/call`；
- 被测版本：DBHub 1.5.1、`server-postgres` 0.6.2、Postgres MCP Pro（Docker latest）、MongoDB MCP 3.2.2、Supabase MCP 0.16.1；
- 探针初始化使用 2025-06-18 协议版本；当前 MCP 规范为 2026-07-28，被测服务器均向后兼容；
- 所有结论的可复现命令见第 7 节。

### 1.4 局限

- 托管型服务器（Supabase/Neon/Snowflake/Databricks/AWS）没有真实云账号，只能做源码与文档级核对，无法端到端验证其云端行为；
- 仓库为调研当日 HEAD，版本迭代后细节可能变化；
- 社区服务器数量庞大，本文选代表性样本，不追求穷举。

---

## 2. 问题拆解：能力、边界、权限

先统一三个容易混淆的概念：

| 概念 | 回答的问题 | 典型手段 |
|---|---|---|
| **能力（Capability）** | Agent 能对数据库做什么？ | 工具清单、工具粒度、资源/模板 |
| **边界（Boundary）** | 能力被限制在哪里？ | 只读模式、SQL 策略、行数/超时、作用域 |
| **权限（Permission）** | 谁被允许使用哪种能力？ | 认证、OAuth scope、工具白名单、数据库角色 |

一次 MCP 调用的信任链：

```
用户 / Agent
   │  ① 客户端决定"是否允许调用这个工具"（allow/ask/deny）
   ▼
MCP Client (Claude Code / Desktop / IDE)
   │  ② 传输认证：stdio 进程信任 / HTTP OAuth 2.1
   ▼
MCP Server（持有数据库凭据）
   │  ③ 服务器决定"这个身份能调用哪些工具、以什么模式执行"
   │  ④ SQL 策略：语句分类、只读事务、多语句拒绝
   ▼
数据库
   │  ⑤ 数据库角色/RLS/资源治理：最终强制点
   ▼
数据（同时是⑥ 提示注入的输入源）
```

**核心判断**：① 和 ③ 是"策略层"，可以绕过或写错；⑤ 是"强制层"，必须默认最小权限。成熟实现会把 ③④⑤ 叠加，而不是只做其中一个。

---

## 3. 能力面：数据库 MCP 能使用数据库的哪些能力

### 3.1 能力分层

把市面上出现的能力按"风险/权限"从低到高分为 6 层：

| 层级 | 能力 | 典型工具/行为 | 风险 |
|---|---|---|---|
| **T0 元数据** | 库/表/列/索引/约束/分区/扩展 | `list_tables`、`describe_table`、`collection-schema`、`search_objects` | 泄露 schema、表名、注释 |
| **T1 只读查询** | SELECT / find / aggregate / 全文/向量检索 | `execute_sql`（只读）、`find`、`esql`、`vector_search` | 全表扫描、敏感数据读取、资源耗尽 |
| **T2 诊断** | EXPLAIN、慢查询、锁、复制、统计、健康检查、索引建议 | `explain_query`、`get_top_queries`、`analyze_db_health`、`list_locks`、`replication_stats` | 泄露查询文本、业务信息；诊断工具可能很重 |
| **T3 写入（DML）** | INSERT/UPDATE/DELETE、批量写 | `insert-many`、`update-many`、`delete-many` | 数据损坏、误删、越权修改 |
| **T4 DDL/迁移** | CREATE/ALTER/DROP、迁移、建索引 | `apply_migration`、`create_table`、`create-index` | 结构破坏、锁表、不可逆 |
| **T5 运维/控制面** | 建/删实例、扩缩容、重启、备份、用户/权限、复制管理 | `create_cluster`、`pause_project`、`restart_db_node`、`create_user` | 影响面远超单库，可能造成停机/资损 |

> **结论**：大多数数据库 MCP 的能力集中在 T0–T2；T3–T5 是否暴露、如何暴露，是各产品差异最大的地方，也是权限设计的重点。

### 3.2 四种工具设计范式

**A. 单一通用 SQL 工具**（最常见）

- 代表：`server-postgres` 的 `query`；DBHub 的 `execute_sql`；ClickHouse 的 `run_query`；TiDB 的 `db_query`/`db_execute`；Oracle SQLcl 的 `run-sql`。
- 优点：实现简单、覆盖面大、token 效率高。
- 缺点：能力边界几乎完全依赖 SQL 策略和数据库角色；模型可以构造任意语句；工具描述很难准确表达"能做什么/不能做什么"。

**B. 操作型工具**（一个工具一个数据库操作）

- 代表：MongoDB 的 `find`/`insert-many`/`drop-collection`；Redis 的 `set`/`hset`/`zadd`；Microsoft SQL MCP 的 `read_records`/`create_record`/`delete_record`；Neo4j 的 `read_neo4j_cypher`/`write_neo4j_cypher`。
- 优点：能力显式、易于按工具做权限和审计、便于做参数校验。
- 缺点：工具数量多、上下文成本高、复杂查询表达能力弱。

**C. 预置/定制工具**（把"可执行的操作"收敛成白名单）

- 代表：DBHub 的 `[[tools]]` 自定义参数化 SQL；Google MCP Toolbox 的 toolset；Supabase 的 feature groups；Microsoft DAB 的 entity + `custom-tool`。
- 优点：只暴露经过审核的 SQL/操作；参数化避免注入；可以把"业务语义"直接给模型。
- 缺点：需要人工维护；灵活性下降。

**D. 资源/模板**（只读上下文，不走工具调用）

- 代表：OceanBase 的 `oceanbase://tables` 资源；PolarDB 的 `polardb-mysql://{table}/data` 模板；部分服务器把 schema 作为 MCP resources。
- 优点：把 schema/样本数据以结构化方式提供给模型，减少工具往返。
- 缺点：资源同样是数据出口，需要与工具同等级别的权限与脱敏。

### 3.3 代表性服务器的工具面

| 服务器 | 工具数量 | 能力覆盖 | 备注 |
|---|---:|---|---|
| `server-postgres` 0.6.2 | 1 | T1 | 仅 `query`，已 deprecated |
| DBHub 1.5.1 | 2（+2 opt-in） | T0–T4 | `execute_sql`、`search_objects`；`explain_sql`、`health_check` 需显式开启 |
| Postgres MCP Pro | 9 | T0–T4 | 含 `explain_query`、`analyze_workload_indexes`、`analyze_db_health`、`get_top_queries` |
| Supabase MCP | 36（全量）/ 5（database）/ 4（database+read-only） | T0–T5 | feature groups 可裁剪；含项目/分支/Edge Function/Notebook |
| MongoDB MCP | 28（默认）/ 20（read-only） | T0–T4 | 写工具在 read-only 下直接消失 |
| ClickHouse MCP | 2–3 | T1–T4 | `run_query`、`list_databases`、`list_tables` |
| Google Toolbox (Postgres) | 29 | T0–T4 | 预置工具集含锁、复制、膨胀、无效索引、参数、角色 |
| Oracle SQLcl MCP | 5 | T1–T5 | `list-connections`/`connect`/`disconnect`/`run-sql`/`run-sqlcl` |
| Microsoft SQL MCP (DAB) | 7 | T3 为主 | 明确只做 DML，不做 DDL |
| Neo4j Cypher MCP | 3 | T0–T3 | 读写工具分离，`--read-only` 移除写工具 |
| Redis MCP | 40+ | T3 为主 | 几乎一对一映射 Redis 命令，无只读模式 |
| TiDB MCP | 7 | T0–T5 | 含 `db_create_user`/`db_remove_user` |
| OceanBase MCP | 10+ | T1–T2 | 另有独立 OCP/OBCloud/obshell 运维 server |
| PolarDB MySQL/PG | 7 / 1 | T1–T4 | 写操作按 INSERT/UPDATE/DELETE/DDL 四个开关控制 |
| PolarDB OpenAPI | 28 | T5 | 建集群、改参数、重启节点、改白名单 |
| Elasticsearch MCP | 5 | T1 | 仅检索类，仓库已 deprecated |

> **观察**：工具数量从 1 到 40+ 不等，但"能力覆盖"与"安全性"没有正相关。真正决定安全的是**默认姿态**和**强制层**，而不是工具多少。

### 3.4 数据库内核可以暴露的独有能力

如果你的 MCP Server 面向数据库内核，以下能力比通用 `execute_sql` 更有价值，也更安全：

- **计划与优化器**：`explain_query`（默认不带 ANALYZE）、计划树、代价、基数估计、访问路径；
- **统计信息**：表/列统计、直方图、采样、统计过期状态；
- **索引**：现有索引、未使用索引、无效索引、索引建议（workload/query 两个维度）；
- **并发与锁**：当前会话、锁等待、阻塞链、长事务、死锁历史；
- **复制与一致性**：LSN/位点、备库延迟、复制槽、一致性快照；
- **存储与维护**：表膨胀、碎片、compaction、vacuum 状态、冷热数据分布；
- **健康与容量**：连接数、缓存命中、磁盘/内存、慢查询 Top N；
- **参数与配置**：只读查看关键参数（不要暴露 `SET`/`ALTER SYSTEM`）；
- **迁移/DDL**：作为独立的高危工具，默认关闭，需确认；
- **多租户/权限**：用户、角色、授权（属于 T5，建议放到独立控制面）。

这些能力大多可以做成**参数化、只读、可审计**的工具，不需要把原始 SQL 的全部表达能力交给模型。

---

## 4. 边界：八层防御

把市面上所有边界机制归到 8 层（L0–L7）。层号越低越靠近 Agent，越高越靠近数据。

### L0 进程/传输边界

- **stdio**：MCP Server 作为客户端子进程运行，继承启动者的 OS 权限与环境变量。没有 MCP 层认证；能启动进程的人就能读配置里的数据库凭据。
- **HTTP/SSE**：必须自己加认证。DBHub 用静态 Bearer token；ClickHouse MCP 支持 `CLICKHOUSE_MCP_AUTH_TOKEN` 或 FastMCP OAuth/OIDC；Supabase/Neon/Snowflake/Databricks 用 OAuth。
- **教训**：stdio 适合"开发者本机"；一旦多用户/远程，静态共享 token 只能算最低配，无法区分"谁在用"。

### L1 工具面裁剪（最有效）

- **不注册写工具**：MongoDB `--readOnly` 只注册 read/connect/metadata 工具；Neo4j `--read-only` 不注册 `write_neo4j_cypher`；CockroachDB 默认只注册读工具。
- **feature group / toolset**：Supabase 的 `--features database` 把 36 个工具缩到 5 个；Google Toolbox 用 `--prebuilt=postgres/data` 或 `/mcp/{toolset}` 只暴露一个工具集。
- **per-tool config**：DBHub 的 `[[tools]]` 可以只保留 `execute_sql`，并把 `readonly`/`max_rows` 固定；自定义工具则只暴露审核过的参数化 SQL。
- **实验 E5**：Supabase 全量 36 个工具，`--features database` 后 5 个，再加 `--read-only` 后 4 个（`apply_migration` 消失），`--read-only` 单独使用时 22 个。`[实验]`

**为什么有效**：模型无法调用不存在的工具；提示注入也只能在"已暴露的工具"里选择。这是比"调用时再拒绝"更早、更硬的收敛点。

### L2 访问模式（readonly / restricted / unrestricted）

| 实现 | 行为 | 代表 |
|---|---|---|
| 布尔只读 | 开启后拒绝写/DDL | DBHub `readonly`、MongoDB `--readOnly`、Neo4j `--read-only`、Qdrant `QDRANT_READ_ONLY`、MariaDB `MCP_READ_ONLY`（默认 true） |
| 三档模式 | restricted 只允许只读语义；unrestricted 放开 | Postgres MCP Pro `--access-mode=restricted/unrestricted` |
| 按操作开关 | INSERT/UPDATE/DELETE/DDL 分别开关 | PolarDB 的 `POLARDB_*_ENABLE_INSERT/UPDATE/DELETE/DDL` |
| 两级写开关 | 先允许写，再允许破坏性操作 | ClickHouse `CLICKHOUSE_ALLOW_WRITE_ACCESS` + `CLICKHOUSE_ALLOW_DROP` |
| 无模式 | 只能靠数据库角色 | TiDB、OceanBase、Redis、Oracle SQLcl |

**注意**：同一"只读"名字下，强制点可能完全不同。DBHub 的 `readonly` 同时做 SQL 分类、`default_transaction_read_only=on` 和 `BEGIN READ ONLY`；某些社区服务器只在应用层做正则匹配，数据库角色仍是可写用户。

### L3 SQL 策略（谁能执行什么语句）

四种常见实现，强度递增：

1. **关键字/正则匹配**：AWS MySQL 明确称为 "best-effort SQL-text safeguard, not a security boundary"；可被注释、大小写、多语句、函数调用绕过。
2. **语句解析器 + 白名单/黑名单**：AWS Postgres 用 `pglast`（libpg_query）只允许 `SELECT`/`WITH … SELECT`/`VALUES`/`TABLE`/`SHOW`/`EXPLAIN`，拒绝 `nextval()`、`COPY … PROGRAM`、文件读取、`dblink`、`pg_sleep`、关闭 `row_security`，多语句拒绝，解析失败 fail-closed；Postgres MCP Pro 的 restricted 模式同样基于解析器；DBHub 用语句拆分 + 分类器（read/dml/ddl/admin/unknown）并对最严格类别裁决。
3. **只读事务**：`BEGIN TRANSACTION READ ONLY` 或连接级 `default_transaction_read_only=on`。它能阻止事务内的写，但**不能阻止语句自己 COMMIT 后再写**——这正是官方 Postgres server 的漏洞。
4. **服务端权限**：数据库角色没有写权限。无论 SQL 文本长什么样，最终由数据库拒绝。

**实验 E1**：官方 `server-postgres` 的实现是：

```js
await client.query("BEGIN TRANSACTION READ ONLY");
const result = await client.query(sql);
...
await client.query("ROLLBACK");
```

传入 `SELECT 1; COMMIT; DROP TABLE canary;` 后，`COMMIT` 结束了只读事务，`DROP` 在自动提交模式下执行，表被删除。`[实验]`

**实验 E2**：把同一个 server 的连接换成只有 `SELECT` 权限的 `ro_user`，同样的 payload 返回：

```
must be owner of table canary4
```

表仍然存在。`[实验]`

> **结论**：L3 只能"减少误操作"，L4 才能"阻止恶意操作"。两者必须叠加。

### L4 数据库角色/权限（最终强制层）

市面实现的做法：

- **显式建议最小权限角色**：ClickHouse 官方明确"flag 不是安全边界，ClickHouse user 的 grants 才是"；Neon 提供 `roleName` 参数把 SQL 固定到某个 Postgres 角色，并建议只读 Agent 只授 `SELECT`。
- **只读事务 + 只读角色**：CockroachDB 会话强制 `default_transaction_read_only=true`；YugabyteDB 的读查询跑在 `BEGIN READ ONLY` 事务里，写查询另有语句黑名单。
- **权限体检**：AWS Postgres/MSSQL 提供 `--privilege_check warn|enforce`，检测 superuser、`rds_superuser`、`BYPASSRLS`；`enforce` 模式下拒绝过度权限角色。
- **RLS/视图**：Supabase 的边界最终依赖 Postgres 角色权限与 RLS；很多团队给 Agent 暴露只读视图而不是基表。

对内核 MCP Server 的启示：**服务器不应以超级用户连接**。为 Agent 建一个专用角色，只授予它需要的 schema/表/操作；写操作使用另一个角色，且只在写工具路径上使用。

### L5 资源边界（只读也会打挂数据库）

只读查询仍然可以：全表扫描、笛卡尔积、`pg_sleep`、递归 CTE、读取大字段、把结果集撑爆上下文。

| 机制 | 代表 | 备注 |
|---|---|---|
| 行数上限 | MongoDB `MAX_DOCUMENTS_PER_QUERY` 默认 100；MotherDuck `--max-rows` 默认 1024；CockroachDB 10000 行、未带 LIMIT 自动补 100 | 只限制返回，不限制扫描 |
| 字节上限 | MongoDB `MAX_BYTES_PER_QUERY` 16 MiB；Snowflake SQL 响应截断 250 KB；MotherDuck `--max-chars` 50000 | 保护上下文与网络 |
| 查询超时 | ClickHouse `MCP_QUERY_TIMEOUT` 默认 30s；Neo4j 读超时 30s；DBHub `query_timeout` 用 `statement_timeout`；CockroachDB 30s | 必须下推到数据库，客户端超时不够 |
| 并发/连接 | MongoDB 最大活跃连接 10；ClickHouse `MAX_WORKERS` 10；DBHub 连接池 | 防止一个 Agent 占满连接 |
| 结果分页 | ClickHouse `list_tables` page_size 默认 50；DBHub `search_objects` 的 `detail_level`/`limit`；CockroachDB 分页 | 渐进式披露，控制 token |
| 计划/代价防护 | Postgres MCP Pro 的 `explain_query`；部分实现拒绝 `EXPLAIN ANALYZE` | 可在执行前估算代价 |

### L6 作用域（能碰到哪些库/表/集群）

- **连接级**：一个 MCP Server 进程绑定一个 DSN（多数实现）。
- **项目级**：Supabase `--project-ref`、Neon `--projectId`。
- **集群/实例级**：AWS 的 `cluster_identifier`/`db_endpoint`；Databricks 的 warehouse + Unity Catalog。
- **工具级**：DBHub 每个 `[[tools]]` 绑定一个 source；Google Toolbox 的 toolset 绑定 source。
- **schema/表级**：大多数服务器**没有** MCP 级白名单，依赖数据库 grants/RLS/只读视图。这是常见缺口。
- **多连接**：DBHub 支持一个进程连多个库；MongoDB `connect` 工具甚至允许模型在运行时传连接串（凭据由调用方提供），需要特别小心。

### L7 人在回路与审计

- **elicitation（MCP 的用户确认）**：Supabase 对 `execute_sql`/`apply_migration` 的破坏性语句、成本操作、Notebook 删除走 form 确认；MongoDB 有 `CONFIRMATION_REQUIRED_TOOLS`（`drop-database`、`drop-collection`、`delete-many`、`drop-index` 等）；Snowflake `CODING_AGENT` 默认 `always_ask`。
- **客户端权限**：Claude Code 等客户端在工具调用前做 allow/ask/deny；这是用户与 Agent 之间的最后一道交互。
- **审计**：Oracle SQLcl 把每次请求写入 `DBTOOLS$MCP_LOG`（含 client/model/endpoint），并给 LLM 生成的 SQL 加注释标记；Databricks 的 Unity Gateway tracing 记录 `system.ai.*` 调用；MongoDB 有 disk/mcp logger；Supabase 提供 observer 回调。多数服务器没有完整审计。
- **不可信数据标记**：MongoDB 默认在工具响应中加"不可信数据"警告，可用 `MDB_MCP_DISABLE_UNTRUSTED_DATA_WARNING` 关闭。这是对抗提示注入的实用设计。

### 4.8 真实漏洞与提示注入：为什么这些层缺一不可

#### 4.8.1 `server-postgres` 的只读绕过（公开披露）

Datadog Security Labs 在 2025-05-29 公开披露了本报告 E1 的同一类问题：

- 受影响：`@modelcontextprotocol/server-postgres` v0.6.2 及 Docker 镜像 `mcp/postgres`。
- 根因：server 把用户 SQL 包在 `BEGIN TRANSACTION READ ONLY` 中，但 node-postgres 的 `client.query(sql)` 接受**分号分隔的多语句**。`COMMIT; DROP SCHEMA public CASCADE;` 会先结束只读事务，再执行写/DDL；server 随后的 `ROLLBACK` 只产生"没有活动事务"的警告。
- 会话污染：`COMMIT; SET statement_timeout TO 1;` 会让同一连接池中后续查询（包括其他用户）在 1 ms 后失败，直到连接被回收。
- 处理时间线：2025-04-01 报告并给补丁；2025-04-09 Zed 发布 fixed fork `@zeddotdev/postgres-context-server`；2025-05-29 Anthropic 修复 Git 仓库并归档；2025-07-10 npm 标记 deprecated。**该披露没有 CVE 编号。**
- 修复模式：prepared statement（禁止多语句）+ 每次调用后销毁连接 `client.release(true)`。

本报告 E1 在本地 PostgreSQL 16 上复现了同类绕过：`SELECT 1; COMMIT; DROP TABLE canary;` 成功删表。E2 证明数据库只读角色可以拦住它。`[实验]`

#### 4.8.2 其他已确认的数据库 MCP 安全公告

| 编号 | 产品 | 问题 | 影响版本 | 修复 |
|---|---|---|---|---|
| CVE-2025-59333 / GHSA-65hm-pwj5-73pw | `@executeautomation/database-server` | `read_query` 只检查是否以 `SELECT` 开头；多语句 + 有副作用函数（如 `pg_terminate_backend()`） | ≤ 1.1.0 | advisory 未列修复版本 |
| CVE-2026-61789 / GHSA-j656-3hf2-fvjc | DBHub | MySQL/MariaDB 的 `--` 注释解析错误；read-only 校验通过但原串以 `multipleStatements` 执行，可 `SELECT 1--1;DROP TABLE victim` | < 0.22.6 | 0.22.6 |
| CVE-2026-61742 / GHSA-fm8p-53ww-hf6w | DBHub HTTP transport | DNS rebinding + Origin 校验缺陷，未认证浏览器可调用 `execute_sql`、枚举 schema、读写数据 | ≤ 0.22.4 | 0.22.5（建议 0.22.6+） |
| CVE-2026-87911 | AWS `awslabs.postgres-mcp-server` | read-only 校验绕过；`COPY ... TO PROGRAM` 导致 OS command injection（需 superuser 或 `pg_execute_server_program`；self-managed profile over `PG_WIRE_PROTOCOL`） | < 1.1.7 | 1.1.7 |

> 本报告实验使用 DBHub 1.5.1，已高于上述修复版本；引用这些 CVE 是为了说明**失败模式**（字符串检查、多语句、注释解析、Origin 校验），不是指控当前版本。AWS 公告的缓解建议——专用最小权限角色、不要用 superuser/`rds_superuser`/master user、只读只授 `CONNECT`+`USAGE`+`SELECT`——适用于所有数据库 MCP。

#### 4.8.3 提示注入：只读不等于安全

**Supabase MCP 案例（General Analysis，2025-07）**：攻击者在 support ticket 中嵌入指令 → 开发者用 Cursor + Supabase MCP 查看 ticket → 模型把 ticket 内容当指令，读取 `integration_tokens` 表并把内容写回 ticket。关键点：

- 这不是 SQL 注入；数据库以开发者权限正常执行了查询，"No permissions were violated. The agent just followed instructions it should never have trusted."
- `service_role` 绕过 RLS；`read_only=true` 能阻止写入，但**仍然允许该角色能做的读取**。
- Supabase 官方回应：没有收到客户数据泄露报告；这不是 MCP 特有漏洞，而是 LLM 使用工具的方式；"guardrails alone aren't enough"；"even in read-only mode, prompt injection remains the number one concern"；建议"Never connect AI agents directly to production data"，并配合 `read_only=true`、`project_ref`、`features`、人工批准、查询日志。
- 演示使用 dummy data，不是真实客户泄露。

**Invariant Labs GitHub MCP（2025-05-26）**：公开仓库 issue 中的间接提示注入，诱导 agent 读取私有仓库数据并发布到公开 PR。作者强调这不是 GitHub MCP server 的代码缺陷，而是 agent 系统层的架构问题；对齐良好的模型同样会中招。

**MCPXKIT（arXiv:2508.12538）**：归纳 31 种攻击技术（direct/indirect tool injection、malicious-user、LLM-inherent），实验发现 agent 过度信任工具描述、难以区分外部数据与可执行指令，可通过共享上下文做链式攻击。

#### 4.8.4 失败模式与控制映射

| 失败模式 | 典型例子 | 有效控制 |
|---|---|---|
| SQL 字符串检查被绕过 | `startsWith("SELECT")`、注释、大小写、多语句 | 解析器 + 单语句/prepared statement + fail-closed |
| 只读事务被 `COMMIT` 绕过 | server-postgres、AWS postgres | 只读数据库角色 + 连接级只读 + 连接回收 |
| 连接池会话污染 | `SET statement_timeout` | 每次请求独立连接/角色；请求结束销毁连接 |
| 传输层未认证/DNS rebinding | DBHub CVE-2026-61742 | Origin 校验、bind 127.0.0.1、OAuth/token |
| 过宽权限 + 提示注入 | Supabase ticket 案例 | 最小权限角色、非生产数据、只读副本、工具白名单、人工批准 |
| 数据外带 | `export`、大结果集、日志 | egress 控制、行/字节上限、脱敏、审计 |
| 工具描述撒谎/被投毒 | MCPXKIT TPA | 只信可信服务器、客户端 allow/ask、沙箱 |

---

## 5. 权限管控：Agent 到底以谁的身份操作

### 5.1 三条身份链

| 模式 | 数据库看到谁 | 优点 | 风险 |
|---|---|---|---|
| **共享服务账号**（多数 stdio 实现） | MCP Server 的固定 DB 用户 | 简单、易部署 | 所有 Agent/用户共享权限；审计只能到"server"粒度；泄露即全泄露 |
| **每用户 OAuth + 角色映射** | 映射后的 DB 角色（或仍为服务账号但带用户上下文） | 可审计到人、可按用户授权 | 实现复杂；需要 IdP、token 交换、角色映射 |
| **每会话/每租户凭据** | 该会话对应的 DB 用户 | 隔离好 | 凭据生命周期管理复杂；session id 本身不是认证 |

**关键事实**：MCP 协议本身不规定"数据库用户"如何映射。服务器拿到什么凭据，数据库就认为是谁。OAuth 只解决"客户端到 MCP Server"的认证，不自动解决"到数据库"的授权。

### 5.2 MCP 协议层的认证与授权

> 规范版本说明：截至 2026-11，当前 MCP 规范是 **2026-07-28**（上一版 2025-11-25）。本文实验客户端用 2025-06-18 初始化，服务器普遍向后兼容；以下以 2026-07-28 为准，并在涉及旧版差异处标注。

**授权是可选的，但传输方式决定默认信任边界**：

- **stdio**：规范明确说 STDIO 实现 **SHOULD NOT** 走 OAuth，而应从环境变量获取凭据。信任边界是 OS 用户/进程权限——"谁能在本机启动这个 server"就是权限边界；恶意本地 server 等于任意代码执行。
- **Streamable HTTP**：使用 HTTP 的实现 **SHOULD** 遵循 OAuth 2.1 授权规范。MCP Server 作为 **Resource Server**，规范要求：
  - Authorization Server **MUST** 实现 OAuth 2.1；
  - MCP Server **MUST** 实现 **Protected Resource Metadata (RFC 9728)**；
  - MCP Client **MUST** 用 PRM 发现授权服务器；
  - MCP Client **MUST** 实现 **Resource Indicators (RFC 8707)**，在授权请求和 token 请求中都带 `resource`；
  - MCP Server **MUST** 校验 token 的 audience 是"专门发给自己的"；**MUST NOT** 接受或转发其他 token；
  - **禁止 token passthrough**：不能把客户端 token 原样转发给上游/数据库；官方原文是 "Token passthrough is explicitly forbidden"。
- **传输安全**：Streamable HTTP 服务器 **MUST** 校验 `Origin` 防 DNS rebinding，本地运行 **SHOULD** 只 bind `127.0.0.1`，**SHOULD** 对所有连接认证；HTTP+SSE 已 deprecated，应迁移到 Streamable HTTP。
- **2026-07-28 的变化**：移除协议级 session 和 `Mcp-Session-Id`（改为无状态）；server-initiated requests 由 **MRTR** 承载；Roots/Sampling/Logging 标记为 deprecated；**Client ID Metadata Documents** 优先，Dynamic Client Registration 被 deprecated；authorization response 的 `iss` 需要客户端校验（防 mix-up）。
- **scope**：服务器在 401 的 `WWW-Authenticate` 中给出 scope；权限不足返回 403 `insufficient_scope`，客户端走 step-up authorization；客户端只应请求必要 scope，避免 `db:*`、`admin:*` 这类 omnibus scope。
- **对权限设计的影响**：2026-07-28 的 `tools/list` 等列表端点**不再按连接变化**（可缓存、可共享），协议级 session 也已移除。因此"按用户过滤工具列表"只能作为 discovery/UX，**不能当作访问控制**；每次 `tools/call` 都必须重新校验身份、scope 与目标资源。服务器自己 mint 的 handle 只能作为普通工具参数传递，不能当认证凭据。

**含义**：OAuth 解决的是"客户端能否访问这个 MCP Server、token 是否 audience-bound"，**不解决**"这个工具能否对这张表执行这条 SQL"。工具级访问控制仍必须由服务器实现（规范要求 server 校验所有 tool 输入、实现 access controls、限流、清洗输出）。如果 MCP Server 把收到的 token 直接拿去连数据库/调云 API，就是典型的 confused deputy；正确做法是换取受众正确的下游 token，或用服务器自己的凭据 + 用户上下文。

### 5.3 服务器侧的授权模型

市面上出现的 scope/白名单设计：

- **OAuth scope**：Neon 用 `read`/`write` scope，`*` 视为 write；Snowflake 用 `session:role:<role>` 等 scope 选择角色；Supabase 托管连接走 OAuth，自托管用 PAT。
- **URL 参数**：Neon `?readonly=true&projectId=...&category=querying&roleName=app_reader`；Supabase `?read_only=true&project_ref=...&features=database`。
- **工具集**：Google Toolbox 的 toolset、Oracle Toolkit 的 `-Dtools=<toolset|tool|*>`（`*` 不含受保护的 `mcp-admin`）、DBHub 的 `[[tools]]`。
- **每工具开关**：Microsoft DAB 的 `runtime.mcp.dml-tools.<tool>` 与实体级 `entities.<name>.mcp.dml-tools: false`；MongoDB 的 `--disabledTools` 支持按工具名、操作类型、类别禁用。
- **静态 token**：DBHub `--auth-token`（逗号分隔多个 bearer token）、OceanBase `ALLOWED_TOKENS`。它们只证明"持有 token"，不区分用户/权限。

### 5.4 客户端（Agent）侧的权限

Agent 本身没有数据库权限；它只能调用客户端暴露的工具。客户端通常提供工具级 allow/deny/ask，这是**客户端层的真实 enforcement**（Claude Code 文档原话："Permission rules are enforced by Claude Code, not by the model."），但它管不住"被允许的工具内部做了什么"。

**Claude Code**

- 规则按 **deny → ask → allow** 顺序评估，第一个匹配决定结果；deny 优先，规则具体程度不改变顺序。
- MCP 工具名：`mcp__<server>__<tool>`；整个 server 用 `mcp__<server>__*`；所有 MCP 用 `mcp__*`。
- `--allowedTools` 预授权；`--disallowedTools` 做 deny；`--permission-mode` 可选 default/manual、acceptEdits、plan、auto、dontAsk、bypassPermissions。
- 服务器可以在 `tools/list` 的 `_meta["anthropic/requiresUserInteraction"] = true` 标记"每次调用都必须人工批准"：即使 allow 规则匹配、hook 返回 allow、甚至 `bypassPermissions`，仍然提示；`dontAsk` 模式下直接 deny。
- 项目 `.mcp.json` 的 server 在交互式 session 首次使用前需要批准；但**非交互场景（`claude -p`、Agent SDK、cloud sessions）无法弹提示，会直接加载 project-scoped server**，需要 `--strict-mcp-config`、`disabledMcpjsonServers` 等限制。

**Claude Desktop**

- 管理员用 `managedMcpServers[].toolPolicy` 按工具名设置 `allow` / `ask` / `blocked`；`"*": "blocked"` 可实现默认拒绝 + 精确放行。
- 没有 policy 的工具由用户逐次批准（可"批准一次/本任务/长期"）；`mcpPersistentAlwaysAllowEnabled` 可关闭长期批准。
- 官方明确：managed policy 在 desktop host process 执行，优先于用户授权。

**VS Code**

- 默认 Manual，MCP 工具调用需要显式批准；可按 session/workspace/user 授权。
- 可按 source 一次性信任整个 server 的所有工具——对数据库 MCP 风险很高，因为同一个 server 往往同时有只读和写/DDL 工具。
- `chat.tools.global.autoApprove`、`/yolo`、Autopilot 会绕过批准；`chat.tools.eligibleForAutoApproval: false` 可强制某工具人工批准。
- 官方明确："Assisted permissions ... is not a security boundary."；sandbox 与 approval 是两个独立控制。

> **实践建议**：对写/DDL 工具用 deny 或 ask，只对只读工具考虑 allow；不要 blanket allow `mcp__db__*`；对必须每次确认的工具让 server 标 `requiresUserInteraction`；不要把 `bypassPermissions` 用于数据库 MCP。把客户端权限当作"防手滑"，把服务器访问模式当作"防误用"，把数据库角色当作"防攻击"。

### 5.5 多租户陷阱

MongoDB 官方专门提示：`connectionScope` 默认 `session`，但计划改为 `global`；客户端声明的会话标识**不是安全边界**；多用户部署需要自建认证/隔离。注：2026-07-28 规范已移除协议级 session 和 `Mcp-Session-Id`，改用无状态请求；任何自定义 state handle 都必须绑定 principal 并做完整性保护。`[文档]`

同类问题：

- 静态 bearer token 无法区分租户；
- `connect(connectionString)` 这类工具让模型/调用方在运行时指定数据库，凭据可能被诱导切换；
- 一个进程连多个 source 时，工具名后缀（DBHub `_<source>`）只是命名，不是授权；
- 共享连接池下，`SET ROLE`/`search_path` 等会话状态可能串扰。

**正确做法**：认证 token 绑定租户/项目；服务器按 token 选择 source 与 DB 角色；不要把"选择连接"的权力交给模型。

### 5.6 数据库能感知 Agent 的角色吗

**结论：数据库看不到 MCP Client。** 它只看到连接时使用的主体（DB 用户/角色）和会话设置。MCP 的 `clientInfo`（name/version）是客户端**自报、未认证**的字段，不会传播到数据库；2026-07-28 无状态化后连协议级 session 也没有。要让数据库"按 Agent 区分权限"，必须由 MCP Server 把身份**翻译**成数据库主体或会话上下文。

先把四层身份分开：

| 层 | 典型信号 | 可信度 | 数据库可见 |
|---|---|---|---|
| MCP Client 软件 | `clientInfo.name/version` | 自报，任何人可填任意值 | 否 |
| OAuth 客户端 | `client_id` / CIMD | 经授权服务器认证，但只标识"哪个客户端软件"，不标识用户角色 | 否（Server 可见） |
| 终端用户/租户 | OAuth `sub`、IdP claims | 取决于 IdP 与 token 校验，通常可信 | 否，除非显式映射 |
| 数据库主体 | 连接用户/角色、`SET ROLE`、会话 GUC | **数据库强制** | 是 |

**实测（E9）**：同一个 DBHub、同一个 DB 角色 `agent_reader`，只改 `clientInfo.name`（`claude-code` vs `evil-client`），数据库侧 `current_user`、`session_user`、`application_name`、`client_addr` 完全一致，`application_name` 为空，没有任何 clientInfo 痕迹；把 DSN 换成 `agent_writer` 后同一 INSERT 才成功。**数据库认的只有连接主体。**

调研中真正把身份传到数据库的产品：

| Server | 是否传到 DB | 机制 | 边界/限制 |
|---|---|---|---|
| **Neon** | 是（可选） | `?roleName=` 固定 Postgres 登录角色；OAuth 授权页把角色作为固定 grant；工具参数 `role_name` 必须与 pin 一致 | 管理 API 工具仍按 OAuth token 自身权限执行，不受该 DB 角色限制 |
| **Snowflake 托管 MCP** | 是 | 每用户 OAuth 登录映射到 Snowflake 用户；`session:role:<role>` scope 选主角色 | 部分客户端（如 Claude）不支持 role scope，会退回用户 `DEFAULT_ROLE` |
| **ClickHouse MCP** | 是 | 连接使用 ClickHouse 用户；Server 读取并尊重用户/服务端的 `readonly` 设置 | 无 per-request 切换；靠部署多个用户 |
| **Databricks 托管 MCP** | 是 | SQL MCP 以调用者的 Unity Catalog + warehouse 权限执行 | 具体 token 交换/on-behalf-of 机制未公开 |
| **YugabyteDB MCP** | 是（可选） | 文档提到 OIDC / per-user `SET ROLE` | `[文档]`，未实测 |
| **Microsoft SQL MCP (DAB)** | 部分是 | Entra JWT role / stdio `role:<name>` 驱动 DAB 的实体/字段/行 RBAC | 这是 **DAB 角色**，API 层生效；数据库连接通常仍是单一主体 |
| **Supabase MCP** | 否 | PAT/OAuth + `read_only` + `project_ref` 控制工具面与项目 | `clientInfo` 只用于 User-Agent 和反馈；`execute_sql` 用项目 DB 的固定角色 |
| **MongoDB MCP** | 否 | 官方明说 "The server does not distinguish callers" | `mcp-session-id` 由客户端声明，不是安全边界 |
| **server-postgres / DBHub / Postgres MCP Pro** | 否 | 单一 DSN / 服务账号 | 所有调用者共享同一 DB 身份；审计只能到 server |
| **Oracle SQLcl MCP** | 是（按连接） | `list-connections` / `connect` 切换 named connection，每个连接可以是不同 DB 用户 | `connect` 让模型在运行时切库/切身份，属于高风险能力 |

**能按 Agent 控权的三种落地方式**：

1. **每 Agent/租户一个 DB 角色 + 凭据**（Neon `roleName`、每用户 DSN）：隔离最硬，DB 审计天然到角色；代价是角色/凭据数量与轮换成本。
2. **共享账号 + 每请求 `SET ROLE` / `SET LOCAL` + RLS**：Server 从 token 解析 `sub`，在事务内切换到对应角色或写入 `app.user_id`，RLS 用 `current_setting()` 判定。要注意连接池串扰、`SET ROLE` 不能提权、以及必须用 `SET LOCAL`/事务级设置。
3. **平台层 RBAC**（DAB、Supabase scope、Snowflake role scope）：在 API/网关层裁剪工具与实体；数据库角色作为兜底。

**四个坑**：

- 不要用 `clientInfo` 做授权：它没有认证，客户端可以自称任何名字；规范也不保证 `tools/list` 按连接变化。
- 不要把 `Mcp-Session-Id` / 自定义 handle 当身份：客户端可声明，且 2026-07-28 已移除协议级 session。
- `SET ROLE` 只能切到当前登录角色已被授予的角色，不能提权；共享连接池里必须用事务级设置并及时重置。
- 审计到"人"只能在 MCP Server 侧完成：数据库日志最多到 `db_role`；要关联 `sub`/租户，需要 Server 记录并回传 request id。

---

## 6. 横向对比

### 6.1 关系型/OLTP

| Server | 默认姿态 | 写/DDL | 只读强制方式 | 作用域 | 认证 | 资源上限 | 确认/审计 |
|---|---|---|---|---|---|---|---|
| `server-postgres` 0.6.2 | 只读（宣称） | 否 | `BEGIN READ ONLY`，可被 `COMMIT` 绕过 | 单 DSN | 无（stdio） | 无 | 无；已 deprecated |
| DBHub 1.5.1 | 可写 | DML/DDL | 分类器 + `default_transaction_read_only` + `BEGIN READ ONLY`；`readonly` 是 per-tool | 多 source（TOML） | DSN；HTTP 静态 bearer | `query_timeout`、`max_rows`（无默认） | 无内置确认 |
| Postgres MCP Pro | restricted / unrestricted | 两者 | restricted 用解析器校验；unrestricted 原样执行 | 单 DSN | 无（stdio/Docker） | 未找到统一上限 | 无 |
| MariaDB MCP | 默认只读 | `create_database`、向量写不受 SQL 过滤 | `MCP_READ_ONLY=true` + SQL 白名单 + 敏感 SHOW 屏蔽 | 单库 | DSN；HTTP 需自配 auth | 连接池 10 | 无 |
| CockroachDB MCP | 默认只读 | opt-in 写工具 | 只注册读工具 + 会话只读 + 单语句 + 拒绝 `EXPLAIN ANALYZE` | 单库 | 证书/密码；HTTP bearer | 30s、10000 行、自动 LIMIT 100 | 无 |
| YugabyteDB MCP | 默认只读 | opt-in | `BEGIN READ ONLY` + 写语句黑名单 + 可选 WHERE 强制 | 单库 | DSN；OIDC/per-user `SET ROLE` | `statement_timeout` | 无 |
| TiDB MCP | 可写 | DML/DDL/建删用户 | 无 | 单库 | DSN | 未找到 | 无 |
| OceanBase MCP | 可写 | DML/DDL | 无；运维工具限 sys tenant | 单库/租户 | DSN；HTTP 静态 token 列表 | 未找到 | 无 |
| PolarDB MySQL/PG | 写操作默认关 | 四类开关 | `ENABLE_INSERT/UPDATE/DELETE/DDL` 默认 false | 单库 | DSN | 资源模板默认 50 行 | 无 |
| PolarDB OpenAPI | 控制面可写 | 建集群/改参数/重启 | 无只读 flag | 账号/地域 | AK/SK | 未找到 | 无 |
| Oracle SQLcl MCP | 无 SQL 只读 | 任意 SQL/PLSQL | `-R` restrict level（MCP 默认 4） | named connection | 本机连接 | 未找到 | `DBTOOLS$MCP_LOG` 审计 |
| Oracle DB MCP Toolkit | 读写工具分离 | `write-query`/`table`/`transaction` | toolset 白名单；`read-query` 仅 SELECT | toolset | OAuth2/JWT、scope | 事务空闲 120s 回滚 | `list-credentials` 需 scope |
| Microsoft SQL MCP (DAB) | DML 默认开 | **设计上不做 DDL** | 每工具/实体开关 + RBAC + 字段/行级策略 | entity | Entra/JWT；stdio 默认 anonymous | 请求体 1 MB；查询超时 1–600s | OTel/App Insights |
| MySQL 官方 PoC | 可写 | 任意 SQL + NL2SQL 自动执行 | 无 | 连接配置 | 配置文件 | 未找到 | 无；官方称 PoC |
| Redis MCP | 可写 | 40+ 命令 | 无；靠 Redis ACL | Redis DB | DSN/EntraID | 未找到 | 无 |
| Neo4j Cypher MCP | 可写 | Cypher 写 | `--read-only` 移除写工具；`EXPLAIN` 检测 query_type 含 `w` 即拒绝；`RoutingControl.READ` | 单 database | 基本认证 | 读超时 30s、token limit | 无 |
| Qdrant MCP | 可写 | store | `QDRANT_READ_ONLY=true` 禁用写工具 | collection | API key | search limit 10 | 无 |
| MotherDuck MCP | 默认只读 | `--read-write` | 默认只读；SaaS/切库默认关 | 单库 | MotherDuck token | max-rows 1024、max-chars 50000 | 无 |
| Milvus MCP | 可写 | 集合/插入/删除 | 无 | DB | URI/token | limit 5/10 | 无 |

### 6.2 云托管/数仓

| Server | 默认姿态 | 能力面 | 只读/范围控制 | 认证 | 资源/确认 |
|---|---|---|---|---|---|
| Supabase MCP | 默认可写 | T0–T5（数据库/分支/Edge Function/Notebook/账号） | `--read-only` / `?read_only=true`；`--project-ref`；`--features` 分组；只读时隐藏写工具、保留 `execute_sql` | PAT / 托管 OAuth | 破坏性 SQL/成本操作 elicitation；Notebook 约 1 MB |
| Neon MCP | 默认可写 | T0–T5（项目/分支/端点/快照/角色） | `?readonly=true`；OAuth read/write scope；`projectId`、`category`、`roleName`；只读时移除写工具，`run_sql` 跑 READ ONLY 事务 | OAuth / API key | 未找到统一行数/超时；`inspect_database` 分页 |
| ClickHouse MCP | **默认只读** | T1–T4 | 默认 `readonly=1`；写需 `ALLOW_WRITE_ACCESS`；破坏性再需 `ALLOW_DROP` | DB 凭据；HTTP token/OAuth | 查询 30s、10 workers、列表分页 50 |
| Google MCP Toolbox | 按 toolset | T0–T4（Postgres 预置 29 个工具） | toolset 白名单；部分 source 有 `readOnly`；`execute_sql` 默认可写 | DB 账号；Google OAuth | HTTP body 限制；无统一 SQL 限制 |
| Snowflake 托管 MCP | SQL 默认只读 | T0–T5（SQL/Agent/Search/Analyst/UDF） | `SYSTEM_EXECUTE_SQL.read_only` 默认 true；OAuth scope 选 role；`database.schema` server 边界 | OAuth/PAT | 响应 250 KB、query_timeout、50 tools；Coding Agent `always_ask` |
| Databricks 托管 MCP | SQL 可读写 | T0–T5（SQL/Genie/搜索/沙箱/连接器） | `system.ai.dbsql_policy.disallow_writes`；Unity Catalog + warehouse 权限 | OAuth | 结果截断；legacy endpoint 不受 Gateway 策略 |
| AWS Postgres/MySQL/MSSQL | **默认只读** | T0–T4 | `--allow_write_query`；Postgres 用 pglast 解析；MySQL 关键字；MSSQL 强制 rollback；`--privilege_check` | AWS 凭据/Secrets Manager/IAM | 未找到行数/超时 |
| AWS Aurora DSQL | **默认只读** | T0–T3 | `--allow-writes`；只读模式校验 `transact` 的所有语句 | IAM | 未找到 |
| AWS DocumentDB | **默认只读** | T0–T3 | `--allow-write`；只读下 block create/drop/insert/update/delete 与 `$out`/`$merge` | 连接串（启动时固定） | `find`/`aggregate` limit 默认 10 |

### 6.3 规律总结

1. **默认只读**在分析型/云数据库产品中更常见（ClickHouse、AWS、Snowflake），因为主要场景是"问数"；OLTP 产品更倾向"默认可写、用只读开关"（Supabase、Neon、MongoDB）。
2. **越接近数据库内核的厂商，越强调数据库角色**（ClickHouse、Neon、AWS、CockroachDB、YugabyteDB）；越上层的平台，越强调 scope/feature/toolset（Supabase、Databricks、Snowflake）。
3. **提供 HITL 的仍是少数**：Supabase、MongoDB、Snowflake Coding Agent 做了 elicitation；大多数只靠 flag + 角色。
4. **审计普遍缺失**：Oracle SQLcl 是少数把每次请求写入数据库审计表的实现；多数只有应用日志/OTel。
5. **"工具数量"与"安全性"无关**：Redis 暴露 40+ 写命令但没有只读模式；DBHub 只有 2 个工具却有完整的 per-tool 只读/行数/超时控制。

---

## 7. 实验记录（可复现）

> 实验代码在 `experiments/probe_raw.js`；原始输出在 `downloads/probe-*.json`。以下为关键结果。

### E1. 官方 Postgres server 的只读绕过

实现（`@modelcontextprotocol/server-postgres@0.6.2`）：

```js
await client.query("BEGIN TRANSACTION READ ONLY");
const result = await client.query(sql);
...
await client.query("ROLLBACK");
```

调用：

```json
{"tool":"query","args":{"sql":"SELECT 1 AS ok; COMMIT; DROP TABLE canary;"}}
```

结果：`canary` 表被删除。`COMMIT` 结束只读事务后，`DROP TABLE` 在自动提交下执行。`[实验]`

### E2. 数据库只读角色作为硬边界

创建 `ro_user`（仅 `SELECT`），用同一 server、同一 payload：

```
{"code":-32603,"message":"must be owner of table canary4"}
```

`canary4` 仍然存在。`[实验]`

**结论**：L3 的只读事务可以被语句自身绕过；L4 的数据库权限不能。

### E3. DBHub 的只读/行数/超时/自定义工具

配置：

```toml
[[sources]]
id = "pg"
dsn = "postgres://postgres:postgres@localhost:55432/testdb?sslmode=disable"
query_timeout = 2

[[tools]]
name = "execute_sql"
source = "pg"
readonly = true
max_rows = 5
```

| 用例 | 结果 |
|---|---|
| `select * from users order by id` | 返回 5 行，`truncated: true` |
| `insert into users(name) values ('x')` | `READONLY_VIOLATION`，只允许 select/with/explain/show |
| `WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d` | `READONLY_VIOLATION`（分类器识别 CTE 中的 DML） |
| `select 1; drop table canary2;` | `READONLY_VIOLATION`（多语句按最严格类别裁决） |
| `select pg_sleep(5)` | `canceling statement due to statement timeout` |

实现细节（源码）：`readonly` 同时设置连接参数 `-c default_transaction_read_only=on`，并在执行时 `BEGIN READ ONLY`；`max_rows` 通过 SQL 改写 + 截断探测实现；`query_timeout` 下推为 `statement_timeout`。`[源码]`

自定义工具（参数化，模型只能传参数）：

```toml
[[tools]]
name = "find_user"
description = "Find a user by numeric id"
source = "pg"
statement = "SELECT id, name, email FROM users WHERE id = $1"
max_rows = 1

[[tools.parameters]]
name = "id"
type = "integer"
required = true
```

调用 `find_user({"id":7})` 返回单行。`[实验]`

### E4. Postgres MCP Pro 的 restricted / unrestricted

两种模式暴露同样的 9 个工具，差异在执行策略：

| 用例 | restricted | unrestricted |
|---|---|---|
| `insert into users ...` | `Error validating query` | 成功，返回 `id=101` |
| `WITH d AS (DELETE ...) SELECT ...` | 拒绝 | — |
| `select 1; drop table ...` | 拒绝 | — |
| `EXPLAIN ANALYZE insert ...` | 拒绝 | — |
| `EXPLAIN ANALYZE select ...` | 也拒绝（restricted 不接受 ANALYZE） | — |
| `select pg_read_file('/etc/hostname')` | 拒绝（函数/文件读取被拦） | — |
| `select 1 as ok` | 成功 | 成功 |

`[实验]`  
**观察**：restricted 模式是"解析器 + 白名单"路线，安全性高，但会牺牲一部分诊断能力（连只读的 `EXPLAIN ANALYZE` 都不允许）。这是一个明确的产品取舍。

### E5. MongoDB read-only 的工具面差异

| 模式 | 工具数 | 写/DDL 工具 |
|---|---:|---|
| `--readOnly` | 20 | 无：`insert-many`、`update-many`、`delete-many`、`create-collection`、`create-index`、`drop-collection`、`drop-index`、`rename-collection`、`drop-database` 均不出现 |
| 默认 | 28 | 上述 8 个全部出现 |

`[实验]`  
注：上述为未配置连接串/Atlas 凭据时的 `tools/list`；连接 Atlas 后还会出现 `atlas-*` 工具。  
**注意**：只读模式仍保留 `export`（把查询结果导出到文件）和 `connect`（运行时传连接串）。前者是数据外带面，后者是凭据/作用域面，两者都不因"数据库只读"而消失。

### E6. Supabase 的 feature group × read-only 矩阵

| 配置 | 工具数 | 变化 |
|---|---:|---|
| 全量 | 36 | 含 account/branching/functions/notebooks 等 |
| `--features database` | 5 | `list_tables`、`list_extensions`、`list_migrations`、`apply_migration`、`execute_sql` |
| `--features database --read-only` | 4 | `apply_migration` 消失，其余保留（`execute_sql` 仍可用但只读） |
| `--read-only`（全 feature） | 22 | 所有 `readOnlyHint:false` 且不适配只读的工具被隐藏 |

`[实验]`  
注：工具枚举不依赖真实账号，用 dummy token 即可；实际可用性还受账号/项目权限限制。  
**结论**：feature group 与 read-only 是正交的两个收敛维度；read-only 不是"一刀切隐藏所有写工具"，而是允许少数工具以"适配只读"的方式保留（如 `execute_sql`）。

### E7. DBHub HTTP 认证

启动：`dbhub --transport http --port 18080 --auth-token secret123`

| 请求 | 结果 |
|---|---|
| 无 `Authorization` | `401 Unauthorized`，`WWW-Authenticate: Bearer` |
| `Authorization: Bearer secret123` | `200`，返回 initialize 结果 |

`[实验]`  
**结论**：这是静态共享 token，能挡住未授权访问，但无法区分用户/租户；生产多用户场景需要前置 OAuth/OIDC 或网关。

### E8. 工具注解只是 hint

`server-postgres` 的 `query` 没有 annotations；DBHub 的 `execute_sql` 标记 `readOnlyHint:false, destructiveHint:true`；MongoDB 的读工具标记 `readOnlyHint:true`。客户端可以用这些注解做 UI 提示或自动批准，但**规范不保证服务器诚实**，也不能阻止服务器在"只读"工具里执行写操作。`[文档/源码]`

### E9. 数据库看不到 MCP Client

环境：DBHub + PostgreSQL，创建两个登录角色 `agent_reader`（仅 SELECT）与 `agent_writer`（SELECT/INSERT）。

```sql
select current_user, session_user,
       current_setting('application_name', true) as app_name,
       coalesce(inet_client_addr()::text,'local') as client_addr;
```

| clientInfo.name | DSN 角色 | current_user | app_name | INSERT |
|---|---|---|---|---|
| `claude-code` | `agent_reader` | `agent_reader` | `""`（空） | `permission denied for table users` |
| `evil-client` | `agent_reader` | `agent_reader` | `""`（空） | `permission denied for table users` |
| `evil-client` | `agent_writer` | `agent_writer` | `""`（空） | 成功，`id=6` |

两次不同 `clientInfo` 的完整输出逐字节相同（`downloads/probe-identity-claude-code.json` vs `probe-identity-evil-client.json`）。`application_name` 为空，说明 DBHub 没有把客户端信息写入会话；即使写了，它也是 Server 自报的、可伪造的字段。**数据库唯一可靠的身份是连接主体；按 Agent 控权必须由 Server 把身份映射成 DB 角色/会话上下文。** `[实验]`

---

## 8. 对数据库内核 MCP Server 的设计建议

### 8.1 先选人设，再定能力

同一个 MCP Server 不可能同时服务好三种人设：

| 人设 | 主要能力 | 默认权限 | 典型部署 |
|---|---|---|---|
| **开发者助手** | schema、样例数据、只读查询、EXPLAIN | 只读 + 行数/超时 | 本机 stdio |
| **DBA Copilot** | 诊断、锁、复制、索引建议、健康检查 | 只读 + 诊断权限（可看元数据/统计） | 内网 HTTP + SSO |
| **数据/应用 Agent** | 参数化业务操作、有限写 | 默认只读，写操作按工具授权 | 多租户 HTTP + OAuth |

**建议**：第一版只做"开发者助手 + DBA Copilot"的只读能力；写/DDL/运维拆成独立工具集、独立凭据、独立审核流程。

### 8.2 能力清单：暴露什么、不暴露什么

**建议默认暴露（T0–T2）**

- `list_databases` / `list_schemas` / `list_tables` / `describe_table` / `list_indexes` / `list_constraints`
- `run_query`（只读，受限）
- `explain_query`（默认不 ANALYZE）
- `get_table_stats` / `get_column_stats`
- `list_locks` / `list_transactions` / `list_slow_queries`
- `get_replication_status` / `get_server_health`
- `recommend_indexes`（只读分析）
- `get_config`（只读，白名单参数）

**建议 opt-in（T3–T4）**

- `insert` / `update` / `delete`（参数化、带 WHERE 强制、影响行数上限）
- `create_table` / `alter_table` / `create_index`（独立工具，避免通用 SQL 执行 DDL）
- `apply_migration`（两阶段：prepare/complete 或 dry-run + 确认）
- 事务工具（`begin`/`commit`/`rollback`，注意长事务与空闲超时）

**建议不要暴露（或放到独立控制面）**

- `create_user` / `grant` / `revoke` / `drop_user`
- `create_cluster` / `restart` / `failover` / `backup` / `restore`
- `COPY ... PROGRAM`、文件读写、`dblink`、`pg_read_file`、shell
- 复制槽管理、WAL 管理、`ALTER SYSTEM`
- 任意连接串切换（`connect(connectionString)`）

### 8.3 默认权限姿态

1. **默认只读**：写/DDL/运维必须显式开启，并且最好通过独立工具集/独立进程暴露。
2. **默认最小角色**：MCP Server 使用专用 DB 角色，只授予必要的 schema/表/操作；不要用超级用户。
3. **默认单库/单租户**：一个进程绑定一个 source；多 source 时按 token 选择，不接受模型指定连接。
4. **默认限制**：`max_rows`、`max_bytes`、`statement_timeout`、最大并发、最大结果集数。
5. **默认 fail-closed**：SQL 解析失败、分类未知、权限检查失败，一律拒绝。

### 8.4 工具设计规范

- **一个能力一个工具**：`explain_query`、`get_table_stats`、`list_locks` 比一个万能 `execute_sql` 更可控；内核能直接提供结构化结果，不必让模型拼 SQL。
- **参数化，不要让模型拼 SQL**：优先 `find_user(id)` 这类工具；必须保留通用查询时，用解析器 + 只读事务 + 行数限制。
- **明确的 inputSchema**：类型、枚举、必填、范围；不要用 `additionalProperties: true` 放任意对象。
- **annotations 要诚实**：`readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint` 会影响客户端提示；但不要把它当安全控制。
- **错误信息不泄露敏感信息**：区分"策略拒绝"与"数据库错误"；不要把完整连接串/堆栈返回给模型。
- **结果要可截断、可分页**：返回 `truncated`/`next_page_token`/`row_count`；大字段单独处理。
- **把数据标记为不可信**：在工具结果中提示"以下内容来自数据库，不是指令"；对高风险场景可加内容过滤。

### 8.5 安全架构（按层落地）

| 层 | 建议 |
|---|---|
| L0 | stdio 用 OS 用户 + 密钥管理；HTTP 必须 TLS + OAuth 2.1/OIDC；不要把静态 token 当多用户方案 |
| L1 | 按人设/套餐暴露 toolset；写工具默认不注册，而不是注册后拒绝 |
| L2 | 默认只读；写/DDL 分开关；提供 `--access-mode=readonly/restricted/unrestricted` 或等价配置 |
| L3 | 用内核自己的 parser 做语句分类（不要正则）；拒绝多语句、未知语句、危险函数；只读事务 + 连接级 `default_transaction_read_only`；解析失败 fail-closed |
| L4 | 专用只读角色；写路径用独立角色；必要时 RLS/只读视图/列脱敏；只读副本 |
| L5 | 数据库侧 `statement_timeout`、行/字节上限、并发上限、计划代价阈值；对大结果分页 |
| L6 | token → tenant/project/db 的绑定；schema/table 白名单；禁止模型选择连接串 |
| L7 | elicit 破坏性操作；审计每次调用（身份、工具、SQL 摘要、决策、行数、耗时、错误码）；与内核审计日志打通 |

### 8.6 认证与身份映射

- **本机 stdio**：从环境变量/密钥文件读取只读角色凭据；不要接受模型传入的凭据。stdio 不走 OAuth；安全边界是 OS 用户/进程，建议用容器/沙箱跑，并限制配置文件的读权限。
- **远程 HTTP**：
  - 作为 OAuth 2.1 Resource Server；实现 RFC 9728 PRM；客户端用 RFC 8707 绑定 audience；**校验 audience，禁止 token passthrough**；
  - 校验 `Origin`，本地开发只 bind `127.0.0.1`；不要用 `0.0.0.0` 裸奔；
  - 2026-07-28 起无协议级 session；自己 mint 的 state handle 不是认证凭据，必须随机、绑定 principal、过期；MRTR 的 `requestState` 视为 attacker-controlled，影响授权时必须做完整性保护（HMAC/AEAD）并拒绝校验失败；
  - 授权响应校验 `iss`（防 mix-up）；优先 Client ID Metadata Documents，DCR 已 deprecated；
  - scope 设计建议：`db:read`、`db:diagnose`、`db:write`、`db:ddl`、`db:admin`；scope 同时决定工具暴露与 DB 角色；权限不足时用 403 `insufficient_scope` 触发 step-up，避免一次性索要 `db:*`；
  - 身份映射：OAuth `sub` → 租户 → DB 角色；如果做不到每用户角色，至少做到"每租户独立角色 + 审计到 sub"；
  - 多租户：token 绑定 tenant，服务器不信任客户端声明的 session/handle；不要把 session 当认证。
- **客户端策略**：在文档/插件里明确建议用户对写/DDL 工具使用 deny 或 ask，对只读工具才考虑 allow；对必须每次确认的高危工具，在 `tools/list` 的 `_meta` 里标 `requiresUserInteraction`（Claude Code 会强制提示，即使 allow/bypass）；不要建议 `mcp__db__*` 全量 allow。
- **凭据生命周期**：短期 token、自动轮换；日志中脱敏；不要把 DSN 放进工具参数或模型上下文；数据库侧用 `CONNECTION LIMIT` 限制连接数。

### 8.7 审计与可观测

建议记录（结构化）：

```
timestamp, user_sub, tenant, tool_name, access_mode, sql_fingerprint,
decision (allow/deny), deny_reason, rows_returned, bytes_returned,
duration_ms, db_role, error_code, request_id
```

- 不记录完整 SQL 中的敏感常量；记录指纹/归一化 SQL；
- 与内核审计日志/慢查询日志关联；
- 指标：调用量、拒绝率、超时率、平均行数、Top 工具、Top 租户；
- 告警：写操作、DDL、权限拒绝、异常大结果、频繁超时。

### 8.8 反模式清单

1. **只做 SQL 关键字过滤**：注释、大小写、多语句、函数调用都能绕过。
2. **只做 `BEGIN READ ONLY`**：语句自身 `COMMIT` 后可写（官方 Postgres server 的教训）。
3. **用超级用户连接**："只读模式"一旦有 bug 就是全库可写。
4. **把连接串/凭据作为工具参数**：模型可被诱导连到攻击者数据库或越权实例。
5. **默认暴露 30+ 工具**：上下文成本高，攻击面大；按人设裁剪。
6. **依赖 tool annotations 做安全**：注解是 hint，不是 enforcement。
7. **依赖 elicitation**：客户端可能不支持、可能被 `skip_elicitations` 跳过、用户可能无脑批准。
8. **只限制返回行数，不限制扫描**：`SELECT * FROM huge_table ORDER BY ...` 仍可打挂数据库。
9. **没有审计**：出事无法定位是哪个用户/哪次调用。
10. **把 `session id` 当认证**：客户端可伪造，不能作为租户边界。

### 8.9 MVP 路线图

**Phase 1（只读，2–3 周）**

- T0 元数据工具 + `run_query`（只读、解析器校验、行数/超时）
- 专用只读 DB 角色；stdio 部署；审计日志
- 默认只读；写工具不注册

**Phase 2（诊断，2–3 周）**

- `explain_query`、`get_table_stats`、`list_locks`、`list_slow_queries`、`get_replication_status`
- 索引建议（基于查询 workload，只读分析）
- HTTP + OAuth/OIDC；scope `db:read`/`db:diagnose`

**Phase 3（写/DDL，按需）**

- 参数化写工具 + WHERE 强制 + 影响行数上限
- DDL 独立工具/迁移工具 + elicitation + 二次确认
- 独立写角色；审计告警；灰度/审批流

---

## 9. 结论

1. **能力上**：数据库 MCP 已经从"一个 query 工具"发展到覆盖 T0–T5 的完整谱系；但对数据库内核来说，最有价值的是把内核的诊断/优化能力（计划、统计、锁、复制、索引建议）做成结构化工具，而不是复制一个通用 SQL 客户端。
2. **边界上**：真正可靠的边界是"不暴露 + 只读事务 + 数据库角色 + 资源上限"的组合；SQL 文本过滤只能算防误操作。官方 Postgres server 的绕过实验说明，**只读事务本身不是安全边界**。
3. **权限上**：Agent 没有数据库权限，它只拥有"被暴露的工具"；权限收敛发生在客户端（allow/ask/deny）、协议（OAuth scope/audience）、服务器（feature/toolset/access-mode）、数据库（角色/RLS）四个平面。共享服务账号是最常见也最危险的模式。
4. **产品上**：默认只读、工具面裁剪、每用户身份映射、审计与资源限制，是 2025–2026 年数据库 MCP 的明确演进方向；但即使头部产品，也普遍缺少完整的审计与细粒度 schema/table 白名单。
5. **安全上**：数据库 MCP 已出现多起真实问题——只读绕过（server-postgres、ExecuteAutomation、DBHub、AWS postgres-mcp-server）、多语句/注释解析绕过、HTTP DNS rebinding、`COPY ... TO PROGRAM` 命令注入，以及 Supabase/GitHub MCP 的提示注入演示。共同教训是：字符串检查不可靠、只读事务不是安全边界、数据库角色是最终强制点、只读也不能阻止读取敏感数据。
6. **对内核团队**：第一版应做"只读 + 诊断"的开发者助手，默认最小权限角色，解析器 fail-closed，行数/超时/并发上限，审计到人；写/DDL/运维作为独立的、默认关闭的能力集，不要让一个 `execute_sql` 承担全部。

---

## 附录 A：主要来源

**规范与安全**

- MCP 版本说明: https://modelcontextprotocol.io/specification/versioning
- MCP 2026-07-28 Changelog: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- MCP Authorization: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- MCP Security Best Practices: https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices
- MCP Tools / annotations: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- MCP stdio transport: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio
- MCP Streamable HTTP transport: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- MCP MRTR: https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr
- MCP Elicitation (旧版): https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation
- MCP 官方博客 "Tool annotations": https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/
- RFC 8707 Resource Indicators: https://www.rfc-editor.org/rfc/rfc8707
- RFC 9728 Protected Resource Metadata: https://www.rfc-editor.org/rfc/rfc9728
- Claude Code permissions: https://code.claude.com/docs/en/permissions
- Claude Code permission modes: https://code.claude.com/docs/en/permission-modes
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
- Claude Desktop MCP configuration: https://claude.com/docs/third-party/claude-desktop/configuration
- VS Code agent approvals: https://code.visualstudio.com/docs/agents/run/approvals
- VS Code agent security: https://code.visualstudio.com/docs/agents/run/security

**安全公告与案例**

- Datadog: SQL injection in PostgreSQL MCP server: https://securitylabs.datadoghq.com/articles/mcp-vulnerability-case-study-SQL-injection-in-the-postgresql-mcp-server/
- CVE-2025-59333 / GHSA-65hm-pwj5-73pw: https://osv.dev/vulnerability/CVE-2025-59333
- CVE-2026-61789 / GHSA-j656-3hf2-fvjc: https://github.com/bytebase/dbhub/security/advisories/GHSA-j656-3hf2-fvjc
- CVE-2026-61742 / GHSA-fm8p-53ww-hf6w: https://github.com/bytebase/dbhub/security/advisories/GHSA-fm8p-53ww-hf6w
- AWS Security Bulletin (CVE-2026-87911): https://aws.amazon.com/security/security-bulletins/2026-104-aws/
- General Analysis: Supabase MCP prompt injection: https://generalanalysis.com/blog/supabase-mcp-blog
- Supabase: defense in depth for MCP: https://supabase.com/blog/defense-in-depth-mcp
- Invariant Labs: GitHub MCP vulnerability: https://invariantlabs.ai/blog/mcp-github-vulnerability
- MCPXKIT (arXiv:2508.12538): https://arxiv.org/abs/2508.12538
- PostgreSQL read-only transaction semantics: https://www.postgresql.org/docs/current/sql-set-transaction.html
- PostgreSQL logging: https://www.postgresql.org/docs/current/runtime-config-logging.html
- NIST least privilege: https://csrc.nist.gov/glossary/term/least_privilege
- OWASP Authorization Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html

**服务器**

- `server-postgres`: https://www.npmjs.com/package/@modelcontextprotocol/server-postgres
- DBHub: https://github.com/bytebase/dbhub ; https://dbhub.ai/config/toml ; https://dbhub.ai/config/command-line
- Postgres MCP Pro: https://github.com/crystaldba/postgres-mcp
- Supabase MCP: https://github.com/supabase-community/supabase-mcp ; https://supabase.com/docs/guides/ai-tools/mcp
- Neon MCP: https://github.com/neondatabase/mcp-server-neon
- ClickHouse MCP: https://github.com/ClickHouse/mcp-clickhouse
- Google MCP Toolbox: https://github.com/googleapis/genai-toolbox ; https://mcp-toolbox.dev/
- Snowflake MCP: https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-mcp
- Databricks MCP: https://docs.databricks.com/aws/en/generative-ai/mcp/managed-mcp
- AWS Labs MCP: https://github.com/awslabs/mcp
- MongoDB MCP: https://github.com/mongodb-js/mongodb-mcp-server
- Oracle SQLcl MCP: https://docs.oracle.com/en/database/oracle/sql-developer-command-line/26.3/sqcug/sqlcl-mcp-server-tools.html
- Oracle DB MCP Toolkit: https://github.com/oracle/mcp
- Microsoft SQL MCP (DAB): https://learn.microsoft.com/en-us/azure/data-api-builder/mcp/overview
- TiDB MCP: https://docs.pingcap.com/ai/tidb-mcp-server/
- OceanBase MCP: https://github.com/oceanbase/awesome-oceanbase-mcp
- PolarDB MCP: https://github.com/aliyun/alibabacloud-polardb-mcp-server
- Redis MCP: https://github.com/redis/mcp-redis
- Neo4j MCP: https://github.com/neo4j-contrib/mcp-neo4j
- Elasticsearch MCP: https://github.com/elastic/mcp-server-elasticsearch
- MariaDB MCP: https://github.com/MariaDB/mcp
- CockroachDB MCP: https://github.com/cockroachdb/cockroachdb-mcp-server
- YugabyteDB MCP: https://github.com/yugabyte/yugabytedb-mcp-server
- MotherDuck MCP: https://github.com/motherduckdb/mcp-server-motherduck
- Qdrant MCP: https://github.com/qdrant/mcp-server-qdrant
- Milvus MCP: https://github.com/zilliztech/mcp-server-milvus

## 附录 B：复现实验

```bash
# 1. 启动 PostgreSQL
docker run -d --name pg-mcp -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=postgres -e POSTGRES_DB=testdb -p 55432:5432 postgres:16-alpine

# 2. 灌数据
docker exec pg-mcp psql -U postgres -d testdb -c "
  create table users(id serial primary key, name text, email text);
  insert into users(name,email)
    select 'user'||g, 'u'||g||'@example.com' from generate_series(1,100) g;"

# 3. 安装探针依赖
cd experiments && npm i @modelcontextprotocol/sdk

# 4. 枚举工具面
CMD=./node_modules/.bin/dbhub \
ARGS='["--dsn","postgres://postgres:postgres@localhost:55432/testdb?sslmode=disable"]' \
node probe_raw.js

# 5. 只读 + 行数限制
CMD=./node_modules/.bin/dbhub ARGS='["--config","configs/dbhub-readonly.toml"]' \
TOOL=execute_sql TOOLARGS='{"sql":"select * from users"}' node probe_raw.js

# 6. 官方 Postgres 只读绕过
CMD=./node_modules/.bin/mcp-server-postgres \
ARGS='["postgresql://postgres:postgres@localhost:55432/testdb"]' \
TOOL=query TOOLARGS='{"sql":"SELECT 1; COMMIT; DROP TABLE canary;"}' node probe_raw.js
```

## 附录 C：术语

- **DSN**：数据库连接串。
- **DML**：INSERT/UPDATE/DELETE。
- **DDL**：CREATE/ALTER/DROP/TRUNCATE。
- **RLS**：Row-Level Security，行级安全策略。
- **HITL**：Human-in-the-loop，人在回路。
- **elicitation**：MCP 中服务器请求客户端向用户收集输入/确认的机制。
- **toolset / feature group**：把工具分成可独立启用的组，用于裁剪工具面。
- **confused deputy**：持有高权限的中间人（MCP Server）被低权限调用者诱导，代其执行高权限操作。
- **token passthrough**：MCP Server 把客户端 token 原样转发给上游/数据库；规范禁止。
