# 上游仓库清单

调研期间只读检出的上游源码，用于核对工具面、访问模式与安全实现。源码本身不入库（许可证与体积原因），按下列 commit 检出即可得到与文中引用一致的版本。

| 目录 | 仓库 | Commit |
|---|---|---|
| `awslabs-mcp` | https://github.com/awslabs/mcp | `29f19e4` |
| `genai-toolbox` | https://github.com/googleapis/genai-toolbox | `06ea49d` |
| `mcp` (Snowflake) | https://github.com/Snowflake-Labs/mcp | `662cb48` |
| `mcp-clickhouse` | https://github.com/ClickHouse/mcp-clickhouse | `a90a8bc` |
| `mcp-server-neon` | https://github.com/neondatabase/mcp-server-neon | `c733b91` |
| `mongodb-mcp-server` | https://github.com/mongodb-js/mongodb-mcp-server | `e17fda3` |
| `supabase-mcp` | https://github.com/supabase-community/supabase-mcp | `6b2fca9` |

检出方式：

```bash
git clone https://github.com/<org>/<repo>.git
git -C <repo> checkout <commit>
```

这些仓库的版权与许可证归各自作者所有，本仓库仅记录引用版本。
