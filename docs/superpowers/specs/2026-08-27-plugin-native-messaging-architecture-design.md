# bb-browser Plugin 与 Native Messaging 架构设计

日期：2026-08-27

状态：待用户审阅

## 1. 背景

当前 bb-browser 的主要链路是：

```text
Codex MCP 进程 -> localhost HTTP daemon -> SSE -> Chrome 扩展 -> Chrome
```

每个 Codex 任务都会启动自己的 MCP 进程，但所有进程共享一个 daemon 和一条扩展 SSE 连接。该结构存在以下问题：

- MCP 会在 daemon 不可达时自行尝试拉起 daemon，多个任务可能竞争同一个生命周期和端口。
- MCP 到 daemon 的固定 30 秒 HTTP 超时会把长时间浏览器操作误判为 daemon 启动失败。
- daemon 没有客户端会话、标签页归属、租约或公平调度，多个任务可能相互干扰。
- 扩展会并发执行从 SSE 收到的命令，同一标签页上的动作没有顺序保证。
- 所有传输失败都可能被包装成误导性的 `Failed to start daemon`。
- 连接失败会被 CashMaker 报告流程解释为全局运行时不兼容，从而跳过后续股票。

本项目已经是 PinoHouse 独立维护的私有分支，不要求继续兼容上游 daemon 架构。目标是把 bb-browser 做成可独立安装的 Codex Plugin，并为后续纳入 CashMaker 保留稳定、非 MCP 专属的客户端接口。

## 2. 设计目标

1. 多个 Codex 任务和定时任务可以同时复用用户当前登录的同一个 Chrome。
2. 不再需要 `bb-browser daemon start/status/stop`、`ensureDaemon()` 或固定的 localhost HTTP 端口。
3. 同一标签页上的命令顺序确定，不同标签页可以并行。
4. 每个调用方拥有独立会话和标签页归属，不能误关或误操作其他会话的页面。
5. Chrome 扩展断线、单个命令超时和站点适配器失败必须得到不同的结构化错误。
6. bb-browser 核心不依赖 MCP SDK；MCP 只是 Codex Plugin 的一个边缘适配器。
7. 保留现有 `mcp__bb_browser__*` 工具名称和主要输入输出契约，减少 CashMaker 工作流迁移成本。
8. 所有浏览器控制数据保留在本机，不引入远程中转服务。

## 3. 非目标

- 第一阶段不支持多个 Chrome Profile 或多个 Chrome 实例。
- 第一阶段只支持 macOS 和 Google Chrome；Linux、Windows 和其他 Chromium 浏览器后续单独设计。
- 不建设远程控制平台、公共云 Broker 或多人共享浏览器。
- 不以兼容上游 bb-browser 的 daemon、OpenClaw 或 CLI 浏览器执行路径为约束。
- 不在第一阶段增加可视化管理 UI。
- Skill 不直接通过 shell 或 CLI 操作浏览器。

## 4. 总体架构

bb-browser 以完整 Codex Plugin 的形态分发，但 Plugin 是安装容器，不是内部通信协议。

```text
bb-browser Plugin
├── Skills
│   └── 描述浏览器操作和站点适配器工作流
├── MCP Adapter
│   └── 为 Codex 暴露结构化工具；不包含浏览器实现
├── Client SDK
│   └── MCP Adapter 与未来 CashMaker 直接复用
├── Native Broker Host
│   ├── 多会话注册
│   ├── 标签页队列与租约
│   ├── 请求路由、超时、取消和健康状态
│   └── Unix Domain Socket 服务
└── Chrome Extension
    └── 通过 Chrome Native Messaging 执行浏览器命令
```

运行链路：

```text
Codex task A ─ MCP Adapter ─┐
Codex task B ─ MCP Adapter ─┼─ Unix socket ─ Native Broker Host
Automation C ─ MCP Adapter ─┘                         │
                                                     │ Native Messaging
                                                     ▼
                                              Chrome Extension
                                                     │
                                                     ▼
                                                   Chrome
```

### 4.1 为什么仍保留薄 MCP Adapter

Skill 只能定义何时以及如何完成工作流，不能单独向 Chrome 提供实时、结构化、受控的动作。Codex Plugin 使用 MCP Adapter 暴露浏览器工具，但下列模块不得导入 MCP SDK：

- 共享协议
- Client SDK
- Broker
- 调度器和租约管理器
- Chrome 扩展
- 站点适配器执行核心

未来 CashMaker 如果需要脱离 Codex 直接调用浏览器，只需使用 Client SDK 连接同一 Broker；不需要启动或嵌入 MCP Server。

### 4.2 为什么使用 Native Messaging

Chrome 扩展通过 `chrome.runtime.connectNative()` 启动并维持 Native Broker Host。Native Host 与扩展之间使用 Chrome 原生的长度前缀 JSON 消息，不再使用 SSE、回调 HTTP 请求或本地 TCP 端口。

优势：

- Native Host 只允许清单中声明的扩展 ID 连接。
- 生命周期由 Chrome 扩展维持，不由任意 MCP 客户端抢占或临时拉起。
- 不开放 localhost 网络端口。
- Chrome 关闭后 Host 可以自然退出；扩展恢复后可以重新建立 Host。

## 5. 组件设计

### 5.1 Shared Protocol

建立与传输无关的 v2 消息协议。请求至少包含：

```text
protocolVersion
requestId
clientId
sessionId
action
tabId (可选)
deadlineAt
idempotency
payload
```

响应至少包含：

```text
protocolVersion
requestId
sessionId
status
data (成功时)
error (失败时)
timing
```

协议还包含 `hello`、`heartbeat`、`cancel`、`session.close` 和 `capabilities` 消息。Native Messaging、Unix socket 和 MCP 都只负责封装或映射这些消息，不定义新的业务语义。

### 5.2 Native Broker Host

Native Host 是唯一共享协调面，承担：

- 维护与 Chrome 扩展的单一 Native Messaging 连接。
- 在用户级运行目录创建 Unix Domain Socket，并将权限限制为当前用户。
- 接受多个 Client SDK/MCP Adapter 连接并创建独立会话。
- 分配请求 ID、验证协议版本、路由响应。
- 维护每个会话的标签页归属和默认标签页。
- 调度每个标签页的命令队列。
- 执行截止时间、取消和断线清理。
- 提供本地健康状态与不包含敏感载荷的结构化日志。

Native Host 不负责解释 MCP，也不包含面向模型的工具描述。

### 5.3 Client SDK

Client SDK 提供稳定的 TypeScript 接口，负责：

- 连接和重连 Unix socket。
- 完成协议握手并获取 `clientId`、`sessionId`。
- 将请求与响应进行关联。
- 支持 `AbortSignal` 和调用级截止时间。
- 把协议错误转换为稳定的类型化异常。

MCP Adapter 只是该 SDK 的调用者。未来可以增加 Python Client SDK 供 CashMaker 服务直接调用，但不属于第一阶段。

### 5.4 MCP Adapter

MCP Adapter 继续以 stdio 方式由每个 Codex 任务启动，但只做以下工作：

- 注册现有 bb-browser 工具及 JSON Schema。
- 为当前进程建立一个 Client SDK 会话。
- 将 MCP 调用映射为内部协议请求。
- 将类型化结果和错误映射为模型可读的结构化内容。

MCP Adapter 不再检查、启动或停止任何后台进程，也不使用 localhost HTTP。连接失败时返回 `broker_unavailable`，并提示检查 Chrome 扩展和 Native Host 安装状态。

### 5.5 Chrome Extension

扩展需要进行以下修改：

- `manifest.json` 增加 `nativeMessaging` 权限。
- 使用固定扩展 ID；Native Host 清单只允许该扩展 origin。
- 用 Native Messaging Client 取代当前 SSE Client 和 `/result` HTTP 回传。
- 在 Service Worker 启动、安装、Chrome 启动和保活 alarm 时确保 Native Port 已连接。
- 上报扩展版本、协议版本和浏览器能力。
- 在 Native Port 断开时使用有上限的退避策略重连。
- 将命令处理结果原路返回，不在扩展内并发执行同一标签页队列中的操作。

已有 `command-handler` 可以继续承担 Chrome API/CDP 操作，但要从传输层解耦。

### 5.6 Codex Plugin

仓库新增标准 Plugin 结构，包含：

- `.codex-plugin/plugin.json`
- 一个或多个 `skills/*/SKILL.md`
- MCP Adapter 声明和构建产物
- Native Host 安装/升级脚本
- Chrome 扩展构建产物和安装说明

安装流程完成后，删除用户配置中的手工 `[mcp_servers.bb-browser] command/args` 条目。新对话由 Plugin 自动获得 Skill 和 MCP 工具。

Native Host 需要一次性用户级安装：

- 将稳定入口安装到 bb-browser 的用户级应用目录。
- 在 Chrome Native Messaging Hosts 目录写入 Host manifest。
- Host manifest 的 `allowed_origins` 只包含固定的 bb-browser 扩展 ID。
- 升级时原子替换可执行文件或稳定符号链接，不让 Host manifest 指向版本化缓存路径。

## 6. 并发与隔离语义

### 6.1 会话

每个 MCP Adapter 连接对应一个 Broker 会话。Broker 记录：

- 会话创建和最后心跳时间。
- 会话打开或认领的标签页。
- 会话默认标签页。
- 正在运行和排队中的请求。
- 会话持有的标签页租约。

连接断开后，Broker 取消尚未开始的请求；已经发送给扩展的请求根据动作的幂等属性决定等待、取消或标记结果未知。短暂重连可以恢复原会话，超过恢复窗口则进行会话清理。

### 6.2 标签页归属

- `open` 创建的标签页默认归创建会话所有。
- 显式选择已有标签页时，会话只获得操作引用，不取得关闭所有权。
- `close_all` 只能关闭当前会话拥有的标签页。
- 操作其他会话拥有的标签页必须显式指定 `tabId`，并经过 Broker 租约调度。
- 不再使用全局 Chrome active tab 作为隐式的跨会话状态；省略 `tabId` 时使用会话自己的默认标签页。

### 6.3 调度

第一阶段采用简单且可验证的规则：

- 同一个标签页上的所有命令串行执行。
- 不同标签页上的命令允许并行。
- 无标签页的全局命令进入独立的全局队列。
- 各会话采用轮转公平调度，避免单个长任务永久占用执行槽。
- `site_run` 可以申请工作流租约，在一次站点适配器事务结束前禁止其他会话插入同一标签页操作。

暂不区分“安全并行读取”和“写操作”；先保证每个标签页严格串行。确认真实使用稳定后再评估只读并行优化。

## 7. 超时、取消与错误模型

固定 30 秒全局超时被替换为分层截止时间：

- 简单标签页和 DOM 命令使用短截止时间。
- 页面加载、下载、站点适配器和 Radar 使用更长的操作级截止时间。
- 调用方传入的截止时间不能超过 Broker 配置的安全上限。
- 排队时间和扩展执行时间分别记录。

错误至少分为：

- `broker_unavailable`
- `extension_disconnected`
- `protocol_version_mismatch`
- `session_expired`
- `tab_not_found`
- `tab_not_owned`
- `tab_lease_timeout`
- `request_deadline_exceeded`
- `request_cancelled`
- `browser_command_failed`
- `adapter_execution_failed`
- `result_unknown_after_disconnect`

错误结果保留 bb-browser 现有的 `error`、`hint`、`action` 三字段规范，并增加稳定的 `code`、`phase`、`retryable`、`requestId`。

只有明确标记为幂等且尚未到达扩展的请求可以自动重试。创建规则、删除规则、点击、填写和提交等动作不能盲目重放。

## 8. X Radar 与 CashMaker 行为

X Radar 扫描作为站点适配器事务运行：

1. 获取或创建当前会话的 Radar 标签页。
2. 对该标签页获取工作流租约。
3. 创建临时 Radar 规则。
4. 等待计数就绪。
5. 读取结果。
6. 在成功、失败或取消路径中清理临时规则。
7. 释放标签页租约。

单只股票的 `adapter_execution_failed` 或操作级超时只影响该股票。只有 `extension_disconnected`、`broker_unavailable` 或协议不兼容才视为全局基础设施故障。即使发生全局故障，报告也必须记录真实错误码，不能再映射为 `adapter_runtime_incompatible`。

CashMaker 的 `report` Skill 继续使用现有 bb-browser 工具名称。完成迁移后重新执行 23 只股票 Radar 扫描，并回填上一次报告。

## 9. 安全设计

- 不监听 TCP 端口，Native Host 只通过 Native Messaging 和用户级 Unix socket 通信。
- Unix socket 与配套运行目录权限限制为当前用户。
- Native Host manifest 仅允许固定的 bb-browser 扩展 ID。
- Client SDK 握手使用每次安装生成、权限受限的本地令牌，降低其他本地进程误接入风险。
- 日志不记录 Cookie、Authorization header、页面正文、表单内容或完整命令载荷。
- 对消息大小、排队数量、并发标签页数量和会话空闲时间设置上限。
- `eval`、`fetch` 和 Chrome debugger 等高权限工具继续明确暴露，不在 Skill 中隐式扩大权限。

## 10. 迁移方案

迁移采用并行构建后一次切换，避免长期维护两套运行路径：

1. 抽取共享 v2 协议、Client SDK 和工具注册模块，保证核心不依赖 MCP。
2. 实现 Native Host、Unix socket、多会话注册和标签页调度器。
3. 将扩展从 SSE/HTTP 切换到 Native Messaging。
4. 将 MCP Server 缩减为 Client SDK Adapter，并保持现有工具契约。
5. 增加 Plugin 清单、Skill、Native Host 安装器和扩展安装产物。
6. 完成自动化及真实 Chrome 验证后，删除 daemon 包、`ensureDaemon()`、SSE Client 和浏览器 CLI 执行路径。
7. 安装 Plugin，移除手工 Codex MCP 配置，重启 Codex 验证新对话和定时任务。

现有 `packages/cli/src/client.ts` 中未提交的用户修改必须保留。迁移时只有在旧 CLI 浏览器路径正式删除的提交中才处理该文件，并在提交说明中明确记录。

## 11. 测试策略

### 11.1 单元测试

- v2 协议编解码、版本拒绝和错误映射。
- Native Messaging 长度前缀消息的分帧、合帧和大小限制。
- Session Registry 的创建、恢复、过期和清理。
- 每标签页串行队列与跨标签页并行。
- 多会话公平调度。
- 租约超时、取消和断线后的结果未知状态。
- MCP 工具与 Client SDK 请求的映射。

### 11.2 集成测试

使用 Fake Extension 和真实 Native Host：

- 三个 MCP 客户端同时连接。
- 三个客户端操作不同标签页时并行完成。
- 多个客户端操作同一标签页时严格按调度顺序执行。
- 一个客户端断开不会取消其他客户端的请求。
- Extension 断开和恢复后，新请求可以继续执行。
- `close_all` 不关闭其他会话拥有的标签页。
- 站点适配器失败后租约和临时资源得到清理。

### 11.3 真实 Chrome 验证

- 使用当前已登录的 Chrome 完成基础 open/snapshot/click/eval 流程。
- 同时启动至少两个 Codex 任务操作不同标签页。
- 对同一标签页制造竞争并验证无动作交错。
- 连续扫描 X Radar 23 只股票，确保所有股票均被尝试。
- 验证不存在遗留 Radar 临时规则。
- 验证无需运行 daemon 命令，系统中也不再依赖 `dist/daemon.js` 或 19824 端口。

## 12. 验收标准

设计实现完成需同时满足：

1. bb-browser 可作为 Codex Plugin 安装，并在新任务中自动提供 Skill 和工具。
2. bb-browser 核心模块不依赖 MCP SDK。
3. Chrome 扩展通过 Native Messaging 连接 Broker。
4. 三个独立客户端可以同时连接同一个 Chrome。
5. 同标签页命令严格串行，不同标签页可以并行。
6. 会话只能批量关闭自己拥有的标签页。
7. 错误能够区分 Broker、扩展、队列、标签页、浏览器命令和站点适配器阶段。
8. 不使用 daemon CLI、SSE、`/result` 回调、localhost 19824 或 MCP 自动拉起后台进程。
9. X Radar 23 只股票全部被尝试，单只失败不会导致其余股票被跳过。
10. 相关单元测试、集成测试、构建和真实 Chrome 验证全部通过。
