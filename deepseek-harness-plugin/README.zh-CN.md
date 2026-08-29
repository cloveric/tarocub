# TaroCub DeepSeek Harness 搜索插件

[![CI](https://github.com/cloveric/tarocub-deepseek-harness-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/cloveric/tarocub-deepseek-harness-plugin/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/cloveric/tarocub-deepseek-harness-plugin)](https://github.com/cloveric/tarocub-deepseek-harness-plugin/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-0f766e.svg)](./LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-%E5%8E%9F%E7%94%9F%E6%8F%92%E4%BB%B6-f97316.svg)](https://github.com/topics/dsh-plugin)

**把带来源链的 Brave + Tavily 实时网页研究，作为 DeepSeek Harness 原生插件直接安装。**

[English](./README.md) · [TaroCub](https://github.com/cloveric/tarocub) · [安全说明](./SECURITY.md) · [Releases](https://github.com/cloveric/tarocub-deepseek-harness-plugin/releases)

这个插件向 Harness 的 `web` profile 安装一个原生 bundle，提供：

- `web_search`：Brave/Tavily 路由搜索；
- `web_extract`：Tavily 精确 URL 正文抽取；
- `provider_status`：不暴露密钥、不请求供应商的本地配置检查；
- `health_check`：显式执行 auth、quota、rate limit、timeout 实际探活；
- `/tarocub`：准确的 TaroCub 配置和验收说明。

它可以独立用于 DeepSeek Harness，不要求安装 TaroCub。

## 为什么需要它

模型原生搜索仍然有价值，但严肃研究还需要稳定的工具协议和可审计来源链。本插件会返回 provider、domain、rank、访问时间、`sourceLog`、抽取哈希和明确的 fallback 提示，而不是把供应商路由隐藏起来。

| 工具 | 供应商路径 | 适合场景 |
|---|---|---|
| `web_search` `quick` | Brave 优先，Tavily 兜底 | 当前文档、URL、价格、新闻和广泛发现 |
| `web_search` `deep` | Tavily 优先，Brave 兜底 | 深度研究和正文导向回答 |
| `web_search` `verify` | Brave + Tavily 并行 | 需要交叉核验的重要结论 |
| `web_extract` | Tavily Extract | 读取用户已经给出的明确 URL |
| `provider_status` | 不发供应商请求 | 检查密钥是否可见 |
| `health_check` | 显式真实请求 | 排查鉴权、额度、限流或超时 |

单个供应商失败时，结果会包含 `fallbacks` 和 `notice`；抽取正文包含 `contentHash`。用户已经给出 URL 时，应先直接读取或抽取该 URL，搜索只用于发现链接或补充背景。

## 架构

```text
DeepSeek Harness web profile
└── tarocub-deepseek-harness-plugin
    ├── tarocub                 有边界的指引 + /tarocub
    └── mcp-cctb-search         @deepseek-ai/dsh-mcp-client
        └── node dist/search-mcp.js
            ├── Brave Search API
            └── Tavily Search + Extract APIs
```

仓库已经提交自包含的 MCP bundle。通过 GitHub 安装时不需要现场构建，也不增加运行时 npm 依赖。

## 安装

前提：

- 已安装带 `web` profile 的 DeepSeek Harness `dsh`；
- Node.js 20 或更新版本；
- 至少一个 Brave 或 Tavily key，才能使用对应供应商工具。

```bash
dsh plugin --profile web add github:cloveric/tarocub-deepseek-harness-plugin
```

安装后重启 Harness。安装成功不等于供应商密钥已配置，也不会创建飞书/Lark应用或启动 TaroCub。

## 配置供应商

在启动 Harness 的同一环境中设置一个或两个密钥：

```bash
export BRAVE_API_KEY="..."
export TAVILY_API_KEY="..."
dsh web
```

`BRAVE_SEARCH_API_KEY` 也可以作为 `BRAVE_API_KEY` 的别名。进程环境变量优先。为了兼容已有 TaroCub/Codex 环境，直接变量缺失时，MCP 只会尝试从 Codex MCP 环境段读取这几个同名变量。

插件绝不会把 key 写入 Harness profile、复制到 workspace，或通过 `provider_status` 返回。只有真正调用供应商工具，或显式调用 `health_check` 时，才会发起供应商请求。

## 验收

先确认 bundle 只贡献一个 Search MCP client：

```bash
dsh --profile web --dump-config | grep -A18 -B2 mcp-cctb-search
```

然后在 Harness 会话中调用 `mcp__cctb_search__provider_status`。这一步只检查配置可见性，不消耗供应商额度；只有需要真实排障时才调用 `mcp__cctb_search__health_check`。

应出现四个工具：

```text
mcp__cctb_search__web_search
mcp__cctb_search__web_extract
mcp__cctb_search__provider_status
mcp__cctb_search__health_check
```

## 更新与卸载

```bash
dsh plugin --profile web update tarocub-deepseek-harness-plugin
dsh plugin --profile web remove tarocub-deepseek-harness-plugin
```

操作后重启 Harness，并重新执行 `dsh --profile web --dump-config`。

## 与 TaroCub 的关系

[TaroCub](https://github.com/cloveric/tarocub) 是另一个独立的、以飞书/Lark 为主平台的本地 agent 网关。它管理的 DeepSeek Host 会链接同一个 `web` profile。

- 安装 `v0.2.0+` 后，TaroCub 会校验 capability marker 和 bundle 入口，再让插件接管 `mcp-cctb-search`。
- 没装插件、仍是旧 companion-only 插件、或入口损坏时，TaroCub 继续使用自己的私有 Search MCP 兜底。
- TaroCub 只在私有 Host 中设置 `TAROCUB_SEARCH_MCP_OWNER=plugin` 或 `bridge`，保证恰好只有一个 client 生效。
- 普通 Harness 不设置这个内部变量，因此插件默认启用。

正常使用 Harness 时不要手工设置 `TAROCUB_SEARCH_MCP_OWNER`。安装插件与部署 TaroCub 飞书服务是两件独立的事。

### 从 TaroCub 子目录来源迁移

旧来源继续兼容：

```bash
dsh plugin --profile web add "github:cloveric/tarocub#path:deepseek-harness-plugin"
```

新安装推荐独立仓库。迁移时先卸载旧 package，再安装独立来源、重启 Harness，并检查只出现一个 client：

```bash
dsh plugin --profile web remove tarocub-deepseek-harness-plugin
dsh plugin --profile web add github:cloveric/tarocub-deepseek-harness-plugin
dsh --profile web --dump-config | grep -c "id: mcp-cctb-search"
```

最后计数必须是 `1`。

## 故障排查

| 现象 | 检查方法 |
|---|---|
| 看不到工具 | 重启 Harness，查看 `--dump-config`，确认插件安装在 `web` profile。 |
| `provider_status` 显示未配置 | key 必须存在于真正启动 `dsh` 的环境，而不是另一个无关 shell。 |
| 搜索返回鉴权、额度或限流错误 | 显式调用 `health_check`，查看脱敏后的状态。 |
| 出现两个 `mcp-cctb-search` | 删除手工添加的重复 patch；正常插件或 TaroCub Host 只会保留一个 owner。 |
| TaroCub 报入口损坏 | 更新或重装插件；修复前 TaroCub 会安全使用 bridge fallback。 |
| 发生供应商 fallback | 用户答案中应保留返回的 `notice`。 |

## 边界与安全

这是 Search MCP 和 DeepSeek Harness 插件，不代理模型流量、不管理飞书/Lark租户、不持久化供应商密钥，也不替代 Harness 原生插件或搜索。密钥边界和漏洞报告方式见 [SECURITY.md](./SECURITY.md)。

## 开发

```bash
npm ci
npm run verify
```

唯一维护源位于 [TaroCub](https://github.com/cloveric/tarocub) 的 `deepseek-harness-plugin/`，再通过 `git subtree` 发布到本仓库。详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
