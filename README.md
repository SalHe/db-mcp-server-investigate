# 数据库 MCP Server 调研

为「数据库内核 MCP Server」做设计前调研：市面上的数据库 MCP Server 暴露了哪些能力、安全边界画在哪里、Agent 调用时权限如何收敛。

**主文档：[docs/database-mcp-server-research.md](docs/database-mcp-server-research.md)**（约 870 行，含来源与实验记录）

## 核心结论

1. **只读是趋势，但实现层次差异极大。** 从最弱的 SQL 关键字/正则过滤，到只读事务，再到「不注册写工具 + 只读事务 + 只读数据库角色」三层叠加，安全性完全不同。
2. **工具面裁剪比运行时拒绝更可靠。** 模型看不到的工具，比「看得到但会被拒绝」的工具更难被提示注入利用。
3. **只读事务不是硬边界。** 官方 `@modelcontextprotocol/server-postgres` 的 `BEGIN TRANSACTION READ ONLY` 可被 `SELECT 1; COMMIT; DROP TABLE ...` 绕过；换成只有 `SELECT` 权限的数据库角色后，同一 payload 被拒绝。**数据库角色才是最终强制层。**
4. **SQL 文本过滤不能当安全边界。** 多语句、CTE 内 DML、注释解析差异都能绕过；必须用内核自己的 parser 做 fail-closed 分类。
5. **权限在四个平面收敛：** 客户端 allow/ask/deny → MCP 传输层 OAuth 2.1/audience → 服务器 scope/feature/access-mode → 数据库角色/RLS。任何一层都不能单独承担安全责任。
6. **Agent 侧确认只是交互层护栏。** 一旦工具被 allow，提示注入就可以驱动它；高风险操作应默认不注册、或强制 `requiresUserInteraction`。
7. **对内核 Server 的建议：** 先做只读 + 诊断，用语义化工具（plan/stats/locks/index advisor）而不是万能 `execute_sql`；写/DDL/运维拆成独立工具集与独立凭据；资源上限与审计前置。

## 仓库结构

```
docs/          调研主文档
experiments/   MCP stdio 探针与 DBHub 配置（可复现实验）
downloads/     各服务器的原始 tools/list / tools/call 输出
evidence/      上游仓库清单（URL + commit SHA），源码本身不入库
```

## 复现实验

需要 Docker 与 Node.js 18+。探针只依赖 Node 内置模块与 `experiments/` 下的 npm 依赖。

```bash
# 1. 启动 PostgreSQL 16
docker run -d --name pg-mcp -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=postgres -e POSTGRES_DB=testdb -p 55432:5432 postgres:16-alpine

# 2. 灌数据
docker exec pg-mcp psql -U postgres -d testdb -c "
  create table users(id serial primary key, name text, email text);
  insert into users(name,email)
    select 'user'||g, 'u'||g||'@example.com' from generate_series(1,100) g;"

# 3. 安装探针依赖
cd experiments && npm ci

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

`probe_raw.js` 直接发 JSON-RPC，绕开 SDK 的结果校验；`probe.js` 走官方 SDK，用于查看 client 视角的 annotations。

## 证据口径

- `[文档]` 官方文档 / README
- `[源码]` 官方仓库源码（对应 commit 记录在 [evidence/README.md](evidence/README.md)）
- `[实验]` 本文本地实测
- `[推断]` 基于以上材料的归纳

## 局限

- 云托管服务（Supabase、Neon、Snowflake、Databricks、AWS 等）用**源码 + 官方文档**核对，未使用真实云账号做端到端验证。
- 实验基于本地 PostgreSQL 16，部分结论（如 MySQL 注释解析）来自上游 issue/安全公告，未逐一复现。
- 调研时间 2026-11，MCP 规范以 **2026-07-28** 版为准；上游产品变化较快，引用前请核对版本。

## 第三方材料

`evidence/` 下不包含上游仓库源码：这些项目各自持有版权与许可证，且体积较大。只保留 `evidence/README.md` 中的仓库地址与 commit SHA，便于按版本核对。文中引用均标注来源。
