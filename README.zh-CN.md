# bb-browser

bb-browser 是一个 Codex Plugin，让 Agent 通过结构化 MCP 工具和站点适配器使用你真实、已登录的 Chrome。该仓库由 PinoHouse 作为独立项目维护。

浏览器执行链路完全本地化并具备会话隔离：不再提供浏览器 CLI、后台 TCP daemon、SSE 桥接或独立自动化浏览器。

## 能力

- 标签页、页面快照、交互、JavaScript、截图和网络请求检查。
- 在 Chrome 登录态中运行并返回结构化数据的站点适配器。
- 按任务隔离的会话、明确的 tab 所有权、公平队列、租约、deadline 与取消。
- 通过本地鉴权 Unix socket 为多个 Codex 任务共享一个 Chrome Native Messaging Host。

## 架构

```text
Codex 任务
  │ Plugin MCP Adapter（stdio）
  ▼
BrowserClient SDK
  │ 已鉴权 Unix socket
  ▼
Native Broker Host
  │ Chrome Native Messaging
  ▼
bb-browser Chrome 扩展
  │ chrome.debugger / Chrome APIs
  ▼
你已登录的 Chrome
```

每个 Codex 任务拥有独立 session。同一 tab 的命令按顺序执行，不同 tab 可以并行；任务只能关闭本 session 创建的 tab。

## 环境要求

- macOS
- Node.js 20 或更高版本
- pnpm 9
- 开启开发者模式的 Google Chrome
- 支持 Plugin 的 Codex 桌面端/CLI

## 快速开始

在仓库根目录执行：

```bash
pnpm install
pnpm build
pnpm install:native-host
```

然后一次性安装 Chrome 扩展：

1. 打开 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择 `packages/extension/dist`。
4. 确认扩展 ID 是 `ncpkoaiijcnacllhjjjfonmbhflmbnii`。

把当前仓库注册为 PinoHouse marketplace 并安装 Plugin：

```bash
codex plugin marketplace add "$(pwd)" --json
codex plugin add bb-browser@pinohouse --json
```

重启 Codex 一次，并新建任务，使安装后的 Skill 与 MCP 工具生效。

## 使用 Plugin

Agent 只调用 Plugin 提供的 `mcp__bb_browser__*` 工具。标准流程是：

1. 列出 tab，或新建 tab 并保存返回的 ID。
2. 快照、读取和操作都显式传入该 tab ID。
3. 导航或动态内容变化后重新获取快照。
4. 只关闭当前任务自己创建的 tab。

工具分组：

- 浏览器：`browser_tab_list`、`browser_open`、`browser_snapshot`、`browser_click`、`browser_fill`、`browser_eval`、`browser_network`、`browser_screenshot`、`browser_close`。
- 站点适配器：`site_list`、`site_search`、`site_info`、`site_recommend`、`site_run`、`site_update`。

`site_run` 是唯一受支持的适配器执行入口。每次执行都有 deadline；Radar 适配器最长可使用 120 秒。

## 运行时文件

`pnpm install:native-host` 只安装用户级文件：

```text
~/Library/Application Support/bb-browser/
  auth-token                         权限 0600
  native-host/
    native-host.js
    bb-browser-native-host           可执行启动器

~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
  com.pinix.bb_browser.json

/tmp/bb-browser-<uid>/
  broker.sock                        运行时权限 0600
```

Native Messaging 清单只允许“快速开始”中的固定扩展来源。协议日志写入 stderr，不记录浏览器 payload 或 auth token。

## 更新

拉取新代码后执行：

```bash
pnpm install
pnpm build
pnpm install:native-host
codex plugin add bb-browser@pinohouse --json
```

如果扩展文件有变化，在 Chrome 中重新加载扩展，然后新建 Codex 任务。重复安装会保留现有 auth token，并原子替换 Host bundle 与清单。

## 从 0.10 迁移

- 删除 `BB_VIA_EXTENSION`；浏览器操作始终走 Plugin MCP Adapter。
- 删除 `BB_DAEMON_HOST` 和 `BB_DAEMON_PORT`。仅在开发时确实需要覆盖本地 Unix socket，才使用 `BB_BROWSER_SOCKET_PATH`。
- 原先固定 60 秒的传输超时改为按操作设置 deadline；Radar 适配器可使用 120 秒。
- 不再支持浏览器 CLI、OpenClaw transport、TCP 19824、HTTP command/result 路由和 SSE transport。

## 开发与验证

```bash
pnpm test
pnpm build
pnpm test:native-host-install
```

主要 package：

- `packages/shared`：浏览器数据类型、v2 协议、错误与 framing。
- `packages/client`：带鉴权的 Broker Client SDK。
- `packages/broker`：Native Host、session、队列、lease 与路由。
- `packages/extension`：Chrome Native Messaging Client 与浏览器命令处理器。
- `packages/sites`：适配器注册与运行器。
- `packages/mcp`：轻量 Codex MCP Adapter。

## 卸载

```bash
pnpm uninstall:native-host
codex plugin remove bb-browser@pinohouse --json
```

如果不再使用，也可以在 `chrome://extensions/` 中移除已解压扩展。

## 许可证

[MIT](LICENSE)
