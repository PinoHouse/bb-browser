# bb-browser Plugin Native Messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 将 bb-browser 改造成以 Codex Plugin 分发、核心不依赖 MCP、通过 Chrome Native Messaging 驱动真实 Chrome，并支持多个 Codex 任务安全并发的本地浏览器控制系统。

**Architecture:** 每个 Codex 任务仍启动一个很薄的 stdio MCP Adapter，但 Adapter 只调用独立 Client SDK。Client SDK 通过用户级 Unix Domain Socket 连接由 Chrome 扩展启动的单例 Native Broker Host；Broker 负责会话、标签页归属、每标签页串行队列、工作流租约、截止时间和错误路由，扩展只负责执行 Chrome/CDP 命令。

**Tech Stack:** TypeScript 5.7、Node.js 20+、pnpm 9、Turborepo、tsup、Vite、Node test runner、Chrome Manifest V3、Chrome Native Messaging、Unix Domain Socket、Model Context Protocol SDK 1.12。

**Spec:** docs/superpowers/specs/2026-08-27-plugin-native-messaging-architecture-design.md

## Global Constraints

- 第一阶段仅支持 macOS 与 Google Chrome。
- 所有浏览器控制数据留在本机，不增加远程 Broker。
- packages/shared、packages/client、packages/broker、packages/sites 和 packages/extension 不得依赖 @modelcontextprotocol/sdk。
- MCP 仅存在于 packages/mcp，并保留现有 mcp__bb_browser__* 工具名称和主要参数契约。
- 不使用 daemon CLI、ensureDaemon、SSE、/result HTTP 回调或 localhost 19824。
- 同一标签页上的命令严格串行，不同标签页可并行。
- close_all 只能关闭当前 Broker 会话拥有的标签页。
- 单个站点适配器失败不能触发其他股票或任务的全局跳过。
- 用户当前未提交的 packages/cli/src/client.ts 修改必须先独立保存，不能被迁移提交覆盖。
- 代码与注释使用英文；用户可见错误提示遵循仓库现有中文文案规范。
- 每项实现先写失败测试，再写最小实现；同一最终 diff 不重复运行等价的全量验证。

---

## Planned File Structure

### packages/shared

- **src/protocol.ts**：保留 Chrome 动作参数和 ResponseData 等业务数据结构。
- **src/protocol-v2.ts**：定义会话、命令、响应、取消、租约和握手消息。
- **src/errors.ts**：定义稳定错误码、阶段、重试属性和三字段用户提示。
- **src/frame-codec.ts**：纯 Uint8Array 的四字节小端长度前缀 JSON 编解码。
- **src/index.ts**：只导出与传输/MCP 无关的公共类型。

### packages/client

- **src/runtime-paths.ts**：计算 socket 和认证令牌路径，支持测试覆盖。
- **src/socket-transport.ts**：Unix socket 连接、帧读写和断线通知。
- **src/browser-client.ts**：握手、请求关联、截止时间、取消、租约和会话关闭。
- **src/index.ts**：稳定 Client SDK 公共接口。

### packages/broker

- **src/session-registry.ts**：会话、心跳、标签页所有权和恢复窗口。
- **src/resource-scheduler.ts**：每标签页/全局资源的公平队列。
- **src/lease-manager.ts**：站点工作流标签页租约。
- **src/extension-channel.ts**：Native Messaging stdin/stdout 通道。
- **src/client-server.ts**：认证 Unix socket 多客户端服务器。
- **src/request-router.ts**：调度、截止时间、取消、请求/响应关联。
- **src/broker-runtime.ts**：组合上述组件并提供健康状态。
- **src/index.ts**：Native Host 可执行入口。

### packages/sites

- **src/registry.ts**：扫描、解析、搜索和读取 adapter 元数据。
- **src/argument-map.ts**：位置参数与具名参数验证。
- **src/runner.ts**：标签页选择、工作流租约、脚本封装和结构化错误。
- **src/service.ts**：list/search/info/recommend/run/update 的公共服务。

### packages/mcp

- **src/result.ts**：内部结果到 MCP content 的映射。
- **src/browser-tools.ts**：浏览器工具 Schema 与处理器。
- **src/site-tools.ts**：站点工具 Schema 与处理器。
- **src/server.ts**：注入 BrowserClient 和 SiteService 创建 McpServer。
- **src/index.ts**：仅负责 stdio 启动和进程退出。

### packages/extension

- **src/background/native-client.ts**：连接 com.pinix.bb_browser 并收发 Native Messaging。
- **src/background/command-handler.ts**：返回 CommandResult，不再自行 HTTP 回传。
- **src/background/index.ts**：Native Client 生命周期和状态查询。
- **src/options.ts / options.html**：显示 Native Host 连接状态，不再配置 upstream URL。
- 删除 **sse-client.ts、api-client.ts、constants.ts**。

### Plugin 与安装

- **.codex-plugin/plugin.json**：bb-browser Plugin 清单。
- **.mcp.json**：本地 MCP Adapter 声明。
- **.agents/plugins/marketplace.json**：PinoHouse 本地 marketplace 条目。
- **bin/bb-browser-mcp**：Plugin 内的 MCP 启动器。
- **scripts/install-native-host.mjs**：用户级 Native Host 安装器。
- **scripts/uninstall-native-host.mjs**：可恢复卸载器。

---

### Task 1: 保存现有 CLI 用户修改

**Files:**
- Existing user change: packages/cli/src/client.ts

**Interfaces:**
- Consumes: 当前工作区中 BB_VIA_EXTENSION、BB_DAEMON_HOST、BB_DAEMON_PORT 与 60 秒 HTTP 请求逻辑。
- Produces: 一个只包含用户原始修改的历史提交；后续任务用 BB_BROWSER_SOCKET_PATH 和调用级 deadline 承接其用途。

- [ ] **Step 1: 确认唯一未提交文件**

Run:

~~~bash
git status --short
git diff -- packages/cli/src/client.ts
~~~

Expected: 只看到 packages/cli/src/client.ts，内容与设计规格记录的 extension transport override 一致。

- [ ] **Step 2: 验证现有修改仍可构建**

Run:

~~~bash
pnpm --filter @bb-browser/cli build
~~~

Expected: exit 0，packages/cli/dist 生成成功。

- [ ] **Step 3: 单独提交用户修改**

~~~bash
git add packages/cli/src/client.ts
git commit -m "fix(cli): preserve extension transport override"
~~~

Expected: 提交只包含 packages/cli/src/client.ts。

---

### Task 2: 定义 v2 协议、错误模型与帧编码

**Files:**
- Create: packages/shared/src/protocol-v2.ts
- Create: packages/shared/src/errors.ts
- Create: packages/shared/src/frame-codec.ts
- Create: packages/shared/src/protocol-v2.test.ts
- Create: packages/shared/src/frame-codec.test.ts
- Modify: packages/shared/src/index.ts
- Modify: packages/shared/package.json

**Interfaces:**
- Consumes: ActionType、Request、ResponseData from packages/shared/src/protocol.ts。
- Produces: PROTOCOL_VERSION、ProtocolError、ClientToBrokerMessage、BrokerToClientMessage、ExtensionToBrokerMessage、BrokerToExtensionMessage、encodeFrame、FrameDecoder。

- [ ] **Step 1: 添加共享包测试入口和失败测试**

Add package script:

~~~json
{
  "scripts": {
    "test": "tsx --test src/*.test.ts"
  },
  "devDependencies": {
    "tsx": "^4.20.6"
  }
}
~~~

Create protocol-v2.test.ts with these assertions:

~~~ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION,
  createProtocolError,
  isRetryableBeforeDispatch,
} from "./index.js";

test("protocol exposes stable version and typed error shape", () => {
  assert.equal(PROTOCOL_VERSION, 2);
  assert.deepEqual(
    createProtocolError("extension_disconnected", "dispatch", "Chrome 扩展未连接"),
    {
      code: "extension_disconnected",
      phase: "dispatch",
      retryable: true,
      error: "Chrome 扩展未连接",
      hint: "请确认 Chrome 已运行且 bb-browser 扩展已启用",
      action: null,
    },
  );
});

test("only undispatched idempotent operations are automatically retryable", () => {
  assert.equal(isRetryableBeforeDispatch("read"), true);
  assert.equal(isRetryableBeforeDispatch("safe_write"), true);
  assert.equal(isRetryableBeforeDispatch("unsafe_write"), false);
});
~~~

Create frame-codec.test.ts:

~~~ts
import test from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, FrameDecoder } from "./index.js";

test("FrameDecoder handles split and coalesced frames", () => {
  const first = encodeFrame({ kind: "heartbeat", sentAt: 1 });
  const second = encodeFrame({ kind: "heartbeat", sentAt: 2 });
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(first.slice(0, 3)), []);
  assert.deepEqual(
    decoder.push(new Uint8Array([...first.slice(3), ...second])),
    [
      { kind: "heartbeat", sentAt: 1 },
      { kind: "heartbeat", sentAt: 2 },
    ],
  );
});
~~~

- [ ] **Step 2: 运行测试并确认失败**

Run:

~~~bash
pnpm install
pnpm --filter @bb-browser/shared test
~~~

Expected: FAIL，缺少 protocol-v2、errors 或 frame-codec 导出。

- [ ] **Step 3: 实现稳定错误类型**

Create errors.ts:

~~~ts
export type ErrorCode =
  | "broker_unavailable"
  | "extension_disconnected"
  | "protocol_version_mismatch"
  | "session_expired"
  | "tab_not_found"
  | "tab_not_owned"
  | "tab_lease_timeout"
  | "request_deadline_exceeded"
  | "request_cancelled"
  | "browser_command_failed"
  | "adapter_execution_failed"
  | "result_unknown_after_disconnect";

export type ErrorPhase =
  | "connect"
  | "handshake"
  | "queue"
  | "dispatch"
  | "execute"
  | "adapter"
  | "cleanup";

export interface ProtocolError {
  code: ErrorCode;
  phase: ErrorPhase;
  retryable: boolean;
  error: string;
  hint: string;
  action: string | null;
}

const RETRYABLE_CODES = new Set<ErrorCode>([
  "broker_unavailable",
  "extension_disconnected",
  "tab_lease_timeout",
  "request_deadline_exceeded",
]);

export function createProtocolError(
  code: ErrorCode,
  phase: ErrorPhase,
  error: string,
  options: { retryable?: boolean } = {},
): ProtocolError {
  return {
    code,
    phase,
    retryable: options.retryable ?? RETRYABLE_CODES.has(code),
    error,
    hint: code === "extension_disconnected"
      ? "请确认 Chrome 已运行且 bb-browser 扩展已启用"
      : "请查看 bb-browser 健康状态后重试",
    action: null,
  };
}
~~~

RequestRouter must pass retryable false for every unsafe_write failure after extension dispatch, even when the base code is request_deadline_exceeded or extension_disconnected.

- [ ] **Step 4: 实现 v2 消息联合类型**

Create protocol-v2.ts with these exact public names:

~~~ts
import type { ActionType, Request, ResponseData } from "./protocol.js";
import type { ProtocolError } from "./errors.js";

export const PROTOCOL_VERSION = 2 as const;
export type Idempotency = "read" | "safe_write" | "unsafe_write";

export function isRetryableBeforeDispatch(
  idempotency: Idempotency,
): boolean {
  return idempotency !== "unsafe_write";
}

export interface ClientHello {
  kind: "client.hello";
  protocolVersion: typeof PROTOCOL_VERSION;
  clientName: string;
  authToken: string;
  resumeSessionId?: string;
  resumeClientId?: string;
}

export interface SessionReady {
  kind: "session.ready";
  protocolVersion: typeof PROTOCOL_VERSION;
  clientId: string;
  sessionId: string;
  resumed: boolean;
}

export interface CommandRequest {
  kind: "command.request";
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  clientId: string;
  sessionId: string;
  action: ActionType;
  tabId?: number | string;
  leaseId?: string;
  deadlineAt: number;
  idempotency: Idempotency;
  payload: Omit<Request, "id" | "action" | "tabId">;
}

export interface CommandResponse {
  kind: "command.response";
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
  success: boolean;
  data?: ResponseData;
  error?: ProtocolError;
  timing: {
    queuedMs: number;
    executionMs: number;
  };
}

export interface LeaseAcquire {
  kind: "lease.acquire";
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
  tabId: number;
  deadlineAt: number;
}

export interface LeaseGranted {
  kind: "lease.granted";
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
  tabId: number;
  leaseId: string;
}

export interface LeaseRelease {
  kind: "lease.release";
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  leaseId: string;
}

export interface RequestCancel {
  kind: "request.cancel";
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
}

export interface SessionCloseOwnedTabs {
  kind: "session.close_owned_tabs";
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
  deadlineAt: number;
}

export interface ExtensionHello {
  kind: "extension.hello";
  protocolVersion: typeof PROTOCOL_VERSION;
  extensionVersion: string;
  capabilities: string[];
}

export interface Heartbeat {
  kind: "heartbeat";
  protocolVersion?: typeof PROTOCOL_VERSION;
  sentAt: number;
}

export type ClientToBrokerMessage =
  | ClientHello
  | CommandRequest
  | LeaseAcquire
  | LeaseRelease
  | RequestCancel
  | SessionCloseOwnedTabs
  | Heartbeat;

export type BrokerToClientMessage =
  | SessionReady
  | CommandResponse
  | LeaseGranted
  | Heartbeat;

export type ExtensionToBrokerMessage =
  | ExtensionHello
  | CommandResponse
  | Heartbeat;

export type BrokerToExtensionMessage =
  | CommandRequest
  | RequestCancel
  | Heartbeat;
~~~

- [ ] **Step 5: 实现长度前缀帧**

Create frame-codec.ts:

~~~ts
const HEADER_BYTES = 4;
const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;

export function encodeFrame(value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(HEADER_BYTES + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length, true);
  frame.set(payload, HEADER_BYTES);
  return frame;
}

export class FrameDecoder {
  private buffer = new Uint8Array();

  constructor(private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {}

  push(chunk: Uint8Array): unknown[] {
    const combined = new Uint8Array(this.buffer.length + chunk.length);
    combined.set(this.buffer);
    combined.set(chunk, this.buffer.length);
    this.buffer = combined;
    const values: unknown[] = [];
    while (this.buffer.length >= HEADER_BYTES) {
      const size = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset,
        this.buffer.byteLength,
      ).getUint32(0, true);
      if (size > this.maxFrameBytes) {
        throw new Error("Frame exceeds configured size limit");
      }
      if (this.buffer.length < HEADER_BYTES + size) break;
      const payload = this.buffer.slice(HEADER_BYTES, HEADER_BYTES + size);
      values.push(JSON.parse(new TextDecoder().decode(payload)));
      this.buffer = this.buffer.slice(HEADER_BYTES + size);
    }
    return values;
  }
}
~~~

- [ ] **Step 6: 导出公共 API 并运行测试**

Update index.ts to export errors.ts、protocol-v2.ts、frame-codec.ts while retaining existing browser data types.

Run:

~~~bash
pnpm --filter @bb-browser/shared test
pnpm --filter @bb-browser/shared build
~~~

Expected: all shared tests PASS，build exit 0。

- [ ] **Step 7: 提交协议层**

~~~bash
git add packages/shared pnpm-lock.yaml
git commit -m "feat(protocol): add session-aware browser protocol"
~~~

---

### Task 3: 实现独立 Client SDK

**Files:**
- Create: packages/client/package.json
- Create: packages/client/tsconfig.json
- Create: packages/client/tsup.config.ts
- Create: packages/client/src/runtime-paths.ts
- Create: packages/client/src/socket-transport.ts
- Create: packages/client/src/browser-client.ts
- Create: packages/client/src/index.ts
- Create: packages/client/src/browser-client.test.ts

**Interfaces:**
- Consumes: ClientToBrokerMessage、BrokerToClientMessage、CommandRequest、CommandResponse、FrameDecoder、encodeFrame。
- Produces: BrowserClient.connect、BrowserClient.command、BrowserClient.withTabLease、BrowserClient.closeOwnedTabs、BrowserClient.close。

- [ ] **Step 1: 创建包清单和失败测试**

Use package name @bb-browser/client with dependencies @bb-browser/shared and scripts build plus test.

Create browser-client.test.ts around an injected transport:

~~~ts
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BrowserClient } from "./browser-client.js";

class FakeTransport extends EventEmitter {
  sent: unknown[] = [];
  send(message: unknown): void { this.sent.push(message); }
  close(): void { this.emit("close"); }
}

test("command uses session identity and resolves matching response", async () => {
  const transport = new FakeTransport();
  const clientPromise = BrowserClient.fromConnectedTransport(
    transport,
    { clientName: "test", authToken: "secret" },
  );
  const hello = transport.sent[0] as { kind: string };
  assert.equal(hello.kind, "client.hello");
  transport.emit("message", {
    kind: "session.ready",
    protocolVersion: 2,
    clientId: "client-1",
    sessionId: "session-1",
    resumed: false,
  });
  const client = await clientPromise;
  const resultPromise = client.command(
    { action: "tab_list" },
    { timeoutMs: 1_000, idempotency: "read" },
  );
  const request = transport.sent[1] as { requestId: string; sessionId: string };
  assert.equal(request.sessionId, "session-1");
  transport.emit("message", {
    kind: "command.response",
    protocolVersion: 2,
    requestId: request.requestId,
    sessionId: "session-1",
    success: true,
    data: { tabs: [] },
    timing: { queuedMs: 0, executionMs: 1 },
  });
  assert.deepEqual((await resultPromise).data, { tabs: [] });
});
~~~

- [ ] **Step 2: 运行测试确认失败**

Run:

~~~bash
pnpm install
pnpm --filter @bb-browser/client test
~~~

Expected: FAIL，BrowserClient 或包尚不存在。

- [ ] **Step 3: 实现运行路径和 socket transport**

runtime-paths.ts must expose:

~~~ts
export interface RuntimePathOptions {
  runtimeRoot?: string;
  configRoot?: string;
}

export function getRuntimePaths(options: RuntimePathOptions = {}) {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const runtimeRoot = options.runtimeRoot
    ?? join(tmpdir(), "bb-browser-" + uid);
  const configRoot = options.configRoot
    ?? join(homedir(), "Library", "Application Support", "bb-browser");
  return {
    runtimeRoot,
    socketPath: process.env.BB_BROWSER_SOCKET_PATH
      ?? join(runtimeRoot, "broker.sock"),
    tokenPath: join(configRoot, "auth-token"),
  };
}
~~~

socket-transport.ts must expose a SocketTransport implementing:

~~~ts
export interface MessageTransport {
  send(message: unknown): void;
  close(): void;
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export async function connectSocketTransport(
  socketPath: string,
): Promise<MessageTransport>;
~~~

Use encodeFrame and FrameDecoder for all socket messages. Convert ENOENT and ECONNREFUSED into broker_unavailable at the BrowserClient boundary.

- [ ] **Step 4: 实现 BrowserClient**

BrowserClient public API:

~~~ts
export interface CommandInput extends Omit<Request, "id"> {}

export interface CommandOptions {
  timeoutMs: number;
  idempotency: Idempotency;
  signal?: AbortSignal;
  leaseId?: string;
}

export interface BrowserClientOptions {
  clientName: string;
  authToken?: string;
  socketPath?: string;
  connectTimeoutMs?: number;
  resumeSessionId?: string;
  resumeClientId?: string;
}

export class BrowserClient {
  static async connect(options?: BrowserClientOptions): Promise<BrowserClient>;
  static async fromConnectedTransport(
    transport: MessageTransport,
    options: BrowserClientOptions,
  ): Promise<BrowserClient>;

  command(
    input: CommandInput,
    options: CommandOptions,
  ): Promise<CommandResponse>;

  withTabLease<T>(
    tabId: number,
    timeoutMs: number,
    work: (leaseId: string) => Promise<T>,
  ): Promise<T>;

  closeOwnedTabs(timeoutMs?: number): Promise<CommandResponse>;
  close(): void;
}
~~~

Use randomUUID for request IDs. On AbortSignal, send request.cancel exactly once. On transport close, reject every pending request with result_unknown_after_disconnect if it was dispatched and extension_disconnected if still waiting for the handshake.

- [ ] **Step 5: 运行 SDK 测试和构建**

Run:

~~~bash
pnpm --filter @bb-browser/client test
pnpm --filter @bb-browser/client build
~~~

Expected: all client tests PASS，TypeScript build exit 0。

- [ ] **Step 6: 提交 Client SDK**

~~~bash
git add packages/client pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(client): add broker socket SDK"
~~~

---

### Task 4: 实现会话、归属、调度与租约

**Files:**
- Create: packages/broker/package.json
- Create: packages/broker/tsconfig.json
- Create: packages/broker/tsup.config.ts
- Create: packages/broker/src/session-registry.ts
- Create: packages/broker/src/resource-scheduler.ts
- Create: packages/broker/src/lease-manager.ts
- Create: packages/broker/src/session-registry.test.ts
- Create: packages/broker/src/resource-scheduler.test.ts
- Create: packages/broker/src/lease-manager.test.ts

**Interfaces:**
- Consumes: sessionId、clientId、tabId、deadlineAt。
- Produces: SessionRegistry、ResourceScheduler、LeaseManager。

- [ ] **Step 1: 编写会话与归属失败测试**

~~~ts
test("closeOwnedTabs returns only tabs created by the session", () => {
  const registry = new SessionRegistry({ recoveryWindowMs: 30_000 });
  const first = registry.create("client-a");
  const second = registry.create("client-b");
  registry.recordOwnedTab(first.sessionId, 101);
  registry.recordReference(first.sessionId, 202);
  registry.recordOwnedTab(second.sessionId, 303);
  assert.deepEqual(registry.ownedTabs(first.sessionId), [101]);
  assert.deepEqual(registry.ownedTabs(second.sessionId), [303]);
});
~~~

- [ ] **Step 2: 编写资源队列和公平性失败测试**

~~~ts
test("same tab is serialized while different tabs run concurrently", async () => {
  const scheduler = new ResourceScheduler();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = scheduler.run("session-a", "tab:1", async () => {
    events.push("a:start");
    await gate;
    events.push("a:end");
  });
  const second = scheduler.run("session-b", "tab:1", async () => {
    events.push("b:start");
  });
  const parallel = scheduler.run("session-c", "tab:2", async () => {
    events.push("c:start");
  });

  await parallel;
  assert.deepEqual(events, ["a:start", "c:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["a:start", "c:start", "a:end", "b:start"]);
});
~~~

- [ ] **Step 3: 编写租约失败测试**

~~~ts
test("lease blocks other sessions and honors the deadline", async () => {
  const leases = new LeaseManager();
  const first = await leases.acquire("session-a", 9, Date.now() + 1_000);
  const waiting = leases.acquire("session-b", 9, Date.now() + 1_000);
  let resolved = false;
  waiting.then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
  leases.release("session-a", first.leaseId);
  assert.equal((await waiting).tabId, 9);

  await assert.rejects(
    leases.acquire("session-c", 9, Date.now() - 1),
    (error: ProtocolError) => error.code === "tab_lease_timeout",
  );
});
~~~

- [ ] **Step 4: 运行测试确认失败**

Run:

~~~bash
pnpm install
pnpm --filter @bb-browser/broker test
~~~

Expected: FAIL，domain classes 尚不存在。

- [ ] **Step 5: 实现 SessionRegistry**

Required API:

~~~ts
export interface SessionRecord {
  clientId: string;
  sessionId: string;
  createdAt: number;
  lastSeenAt: number;
  connected: boolean;
  ownedTabs: Set<number>;
  referencedTabs: Set<number>;
  defaultTabId?: number;
}

export interface SessionRegistryOptions {
  recoveryWindowMs: number;
  idleTimeoutMs?: number;
  maxSessions?: number;
}

export class SessionRegistry {
  constructor(options: SessionRegistryOptions);
  create(clientId: string): SessionRecord;
  resume(sessionId: string, clientId: string): SessionRecord | null;
  touch(sessionId: string): void;
  disconnect(sessionId: string): void;
  expire(now?: number): SessionRecord[];
  require(sessionId: string): SessionRecord;
  recordOwnedTab(sessionId: string, tabId: number): void;
  recordReference(sessionId: string, tabId: number): void;
  setDefaultTab(sessionId: string, tabId: number): void;
  defaultTab(sessionId: string): number | undefined;
  forgetTab(tabId: number): void;
  ownedTabs(sessionId: string): number[];
}
~~~

Resume only succeeds for the same clientId within 30 seconds and only while the Broker process is unchanged. Broker restart creates a new session and in-flight requests become result_unknown_after_disconnect.

Use idleTimeoutMs 300000 and maxSessions 32 in production. Reject the 33rd active session with broker_unavailable and expire disconnected idle sessions before admitting a new one.

- [ ] **Step 6: 实现 ResourceScheduler 和 LeaseManager**

ResourceScheduler must keep one active work item per resource key and group queued work by session ID. After each item, choose the next non-empty session bucket in round-robin order.

Cap each session at 100 queued requests. Reject overflow with broker_unavailable and phase queue. Lease duration is capped at 120000 ms; release expired leases before accepting the next work item.

~~~ts
export class ResourceScheduler {
  run<T>(
    sessionId: string,
    resourceKey: string,
    work: () => Promise<T>,
    options?: { requestId?: string },
  ): Promise<T>;
  cancelQueued(sessionId: string, requestId: string): boolean;
  queuedForSession(sessionId: string): number;
  get queuedCount(): number;
}
~~~

LeaseManager public API:

~~~ts
export class LeaseManager {
  acquire(
    sessionId: string,
    tabId: number,
    deadlineAt: number,
  ): Promise<{ leaseId: string; tabId: number }>;
  assertAccess(sessionId: string, tabId: number, leaseId?: string): void;
  release(sessionId: string, leaseId: string): void;
  releaseSession(sessionId: string): void;
}
~~~

- [ ] **Step 7: 运行 Broker domain 测试**

Run:

~~~bash
pnpm --filter @bb-browser/broker test
~~~

Expected: all session、scheduler、lease tests PASS。

- [ ] **Step 8: 提交调度域**

~~~bash
git add packages/broker pnpm-lock.yaml
git commit -m "feat(broker): add sessions leases and fair queues"
~~~

---

### Task 5: 实现 Native Broker Host 与多客户端路由

**Files:**
- Create: packages/broker/src/extension-channel.ts
- Create: packages/broker/src/client-server.ts
- Create: packages/broker/src/request-router.ts
- Create: packages/broker/src/broker-runtime.ts
- Create: packages/broker/src/index.ts
- Create: packages/broker/src/extension-channel.test.ts
- Create: packages/broker/src/broker-runtime.test.ts
- Modify: packages/broker/tsup.config.ts

**Interfaces:**
- Consumes: MessageTransport、SessionRegistry、ResourceScheduler、LeaseManager、v2 protocol messages。
- Produces: BrokerRuntime.start、BrokerRuntime.stop、BrokerRuntime.health、Native Host executable。

- [ ] **Step 1: 编写 Native Messaging framing 失败测试**

Create a PassThrough stdin/stdout pair. Feed one split extension.hello frame and assert ExtensionChannel emits one decoded message. Call send and decode stdout to assert exactly one Chrome Native Messaging frame.

- [ ] **Step 2: 编写三客户端路由失败测试**

The integration test must:

1. Start BrokerRuntime in a temporary runtimeRoot with auth token secret.
2. Connect three BrowserClient instances.
3. Attach a Fake Extension transport.
4. Send commands to tab 11、12、11.
5. Assert tab 11 requests arrive serially and tab 12 can arrive while tab 11 is running.
6. Disconnect client B and assert clients A/C remain usable.

Also test no extension connection returns:

~~~ts
assert.equal(error.code, "extension_disconnected");
assert.equal(error.phase, "dispatch");
assert.equal(error.retryable, true);
~~~

Use this test shape:

~~~ts
test("three clients share one extension with per-tab ordering", async (t) => {
  const fixture = await createBrokerFixture();
  t.after(async () => fixture.close());
  const [clientA, clientB, clientC] = await Promise.all([
    fixture.connectClient("a"),
    fixture.connectClient("b"),
    fixture.connectClient("c"),
  ]);
  const first = clientA.command(
    { action: "snapshot", tabId: 11 },
    { timeoutMs: 1_000, idempotency: "read" },
  );
  const parallel = clientB.command(
    { action: "snapshot", tabId: 12 },
    { timeoutMs: 1_000, idempotency: "read" },
  );
  const second = clientC.command(
    { action: "get", attribute: "title", tabId: 11 },
    { timeoutMs: 1_000, idempotency: "read" },
  );

  await fixture.extension.waitForDispatchCount(2);
  assert.deepEqual(fixture.extension.dispatchedTabIds(), [11, 12]);
  fixture.extension.resolveNextForTab(12, { tabs: [] });
  await parallel;
  fixture.extension.resolveNextForTab(11, { snapshotData: { snapshot: "", refs: {} } });
  await first;
  await fixture.extension.waitForDispatchCount(3);
  assert.deepEqual(fixture.extension.dispatchedTabIds(), [11, 12, 11]);
  fixture.extension.resolveNextForTab(11, { value: "done" });
  assert.equal((await second).data?.value, "done");

  clientB.close();
  assert.deepEqual(
    (await clientA.command(
      { action: "tab_list" },
      { timeoutMs: 1_000, idempotency: "read" },
    )).data?.tabs,
    [],
  );
});
~~~

createBrokerFixture is defined in the same test file and owns a temporary runtime directory, BrokerRuntime, FakeExtensionChannel, and connectClient helper. Its close method closes clients, stops the runtime, and removes only that temporary directory.

- [ ] **Step 3: 运行测试确认失败**

Run:

~~~bash
pnpm --filter @bb-browser/broker test
~~~

Expected: FAIL，runtime transport classes 尚不存在。

- [ ] **Step 4: 实现 ExtensionChannel**

ExtensionChannel reads process.stdin and writes process.stdout by default, with streams injectable for tests:

~~~ts
export class ExtensionChannel extends EventEmitter {
  constructor(options?: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
  });
  start(): void;
  send(message: BrokerToExtensionMessage): void;
  close(): void;
  get connected(): boolean;
}
~~~

Do not write logs to stdout because stdout is the Native Messaging protocol. Structured logs go to stderr and must omit payloads.

- [ ] **Step 5: 实现认证 ClientServer**

On start:

- create runtimeRoot with mode 0700;
- remove socket only when no live server accepts a probe connection;
- bind socketPath and chmod 0600;
- require client.hello as the first frame;
- compare authToken with timingSafeEqual;
- reject protocol versions other than 2;
- issue session.ready after registry create/resume.

- [ ] **Step 6: 实现 RequestRouter**

RequestRouter behavior:

- Select resource key global for tab_list/history, otherwise tab plus resolved session default tab.
- Reject missing/expired sessions before queueing.
- Honor an active lease before dispatch.
- Check deadline before queueing and immediately before extension dispatch.
- Store pending request state with queuedAt、dispatchedAt、sessionId and idempotency.
- On extension response, calculate queuedMs and executionMs.
- On extension disconnect, reject dispatched requests with result_unknown_after_disconnect.
- Update ownership after successful open/tab_new; forget ownership after successful close/tab_close.
- session.close_owned_tabs snapshots only that session's ownedTabs and closes them one by one through the scheduler.

- [ ] **Step 7: 实现 BrokerRuntime 与可执行入口**

~~~ts
export interface BrokerHealth {
  running: boolean;
  extensionConnected: boolean;
  activeSessions: number;
  pendingRequests: number;
  queuedRequests: number;
  activeLeases: number;
  protocolVersion: 2;
}

export interface BrokerRuntimeOptions {
  runtimeRoot?: string;
  socketPath?: string;
  authToken: string;
  extensionInput?: NodeJS.ReadableStream;
  extensionOutput?: NodeJS.WritableStream;
}

export class BrokerRuntime {
  constructor(options: BrokerRuntimeOptions);
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): BrokerHealth;
}
~~~

index.ts must start one BrokerRuntime, trap SIGTERM/SIGINT, write logs only to stderr, and never bind a TCP port.

- [ ] **Step 8: 运行 Broker 集成测试与构建**

Run:

~~~bash
pnpm --filter @bb-browser/broker test
pnpm --filter @bb-browser/broker build
~~~

Expected: all broker tests PASS，dist/index.js contains a Node shebang and no DAEMON_PORT reference。

- [ ] **Step 9: 提交 Native Broker**

~~~bash
git add packages/broker
git commit -m "feat(broker): add native host request router"
~~~

---

### Task 6: 将 Chrome 扩展切换为 Native Messaging

**Files:**
- Create: packages/extension/src/background/native-client.ts
- Create: packages/extension/src/background/native-client.test.ts
- Modify: packages/extension/src/background/command-handler.ts
- Modify: packages/extension/src/background/index.ts
- Modify: packages/extension/src/options.ts
- Modify: packages/extension/options.html
- Modify: packages/extension/manifest.json
- Modify: packages/extension/package.json
- Delete: packages/extension/src/background/sse-client.ts
- Delete: packages/extension/src/background/api-client.ts
- Delete: packages/extension/src/background/constants.ts

**Interfaces:**
- Consumes: ExtensionHello、CommandRequest、CommandResponse、RequestCancel。
- Produces: NativeClient.connect、NativeClient.disconnect、NativeClient.status and a command-handler returning Promise<CommandResult>。

- [ ] **Step 1: 编写 NativeClient 失败测试**

Inject a fake chrome.runtime NativeMessaging port:

~~~ts
class Listener<T extends (...args: any[]) => void> {
  private handlers: T[] = [];
  addListener(handler: T): void { this.handlers.push(handler); }
  emit(...args: Parameters<T>): void {
    for (const handler of this.handlers) handler(...args);
  }
}

class FakeNativePort {
  sent: any[] = [];
  onMessage = new Listener<(message: unknown) => void>();
  onDisconnect = new Listener<() => void>();
  postMessage(message: unknown): void { this.sent.push(message); }
  disconnect(): void { this.onDisconnect.emit(); }
  receive(message: unknown): void { this.onMessage.emit(message); }
  async flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function commandRequest(requestId: string, action: ActionType): CommandRequest {
  return {
    kind: "command.request",
    protocolVersion: 2,
    requestId,
    clientId: "client-1",
    sessionId: "session-1",
    action,
    deadlineAt: Date.now() + 1_000,
    idempotency: "read",
    payload: {},
  };
}

test("NativeClient sends hello and returns command results", async () => {
  const port = new FakeNativePort();
  const client = new NativeClient({
    connectNative: () => port,
    extensionVersion: "0.11.0",
    handleCommand: async (command) => ({
      id: command.requestId,
      success: true,
      data: { title: "ok" },
    }),
  });
  client.connect();
  assert.equal(port.sent[0].kind, "extension.hello");
  port.receive(commandRequest("request-1", "tab_list"));
  await port.flush();
  assert.equal(port.sent[1].kind, "command.response");
  assert.equal(port.sent[1].requestId, "request-1");
});
~~~

Also assert onDisconnect schedules one bounded exponential reconnect and concurrent connect calls do not create two ports.

- [ ] **Step 2: 运行扩展测试确认失败**

Add test script using tsx --test and run:

~~~bash
pnpm install
pnpm --filter @bb-browser/extension test
~~~

Expected: FAIL，NativeClient 不存在。

- [ ] **Step 3: 实现 NativeClient**

Use host name com.pinix.bb_browser. The client must:

- call chrome.runtime.connectNative once;
- immediately post extension.hello with protocolVersion 2;
- await handleCommand for each command;
- post one command.response for success or failure;
- flatten requestId/action/tabId/payload into ExtensionCommand before calling handleCommand;
- map a handler error string to createProtocolError("browser_command_failed", "execute", result.error);
- treat request.cancel as an AbortController signal for the matching command;
- reconnect after 1、2、4、8、16、30 seconds, capped at 30 seconds;
- expose connected、lastConnectedAt、lastError through status()。

- [ ] **Step 4: 将 command-handler 改成纯返回值**

Change signature:

~~~ts
export type ExtensionCommand = Request & {
  requestId: string;
  sessionId: string;
  deadlineAt: number;
};

export interface CommandResult {
  id: string;
  success: boolean;
  data?: ResponseData;
  error?: string;
}

export async function handleCommand(
  command: ExtensionCommand,
  signal?: AbortSignal,
): Promise<CommandResult>
~~~

Remove sendResult import and replace the final:

~~~ts
await sendResult(result);
~~~

with:

~~~ts
return result;
~~~

Preserve every existing Chrome/CDP handler. Add signal checks before dispatch and around explicit wait loops; do not silently retry clicks, form submissions, rule creation or rule deletion.

- [ ] **Step 5: 固定扩展身份并增加权限**

Add this exact public key and permission to manifest.json:

~~~json
{
  "key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxUCkqtdGjiBGF6ZwnRcPrbA0UjAIVoy0Q5B0FIl3CNt31PXIiRQD8Tklcux1TEM77du0EjdtwN6uZUardxb18/J0BKE8v5x05TrNF60P/+q25KGcz8yBZv/44UZxInmpbxQbVvOkFPIGPxnaSK2VKqELunq72JQH8k+B96dFOJ39wwIqxTOaRQqiTg+r8eiPorFtq5f46ApGt7EiiZPkdTKsc8Pyl7wRfdy0pNyGvPbc47Tp12BWOkNkqK3YI5BwWhI9CZd0JkmteGkvC5I5xtVbrV0LNfRxosIgxrBoeIvhhhD2itRXkTh/lpNzSVftkKOF2jELWEQxEDavLD9B6QIDAQAB",
  "permissions": [
    "nativeMessaging"
  ]
}
~~~

The derived fixed extension ID must be ncpkoaiijcnacllhjjjfonmbhflmbnii. Retain all existing permissions in addition to nativeMessaging.

- [ ] **Step 6: 更新后台入口和 Options 页面**

index.ts creates one NativeClient, connects on worker startup/onInstalled/onStartup, and responds to:

~~~ts
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "bb-browser.status") {
    sendResponse(nativeClient.status());
    return true;
  }
  return false;
});
~~~

Options page displays Host Name、Extension ID、Connected、Last Error and removes the upstream URL input/storage listener.

- [ ] **Step 7: 删除旧传输并验证扩展**

Run:

~~~bash
pnpm --filter @bb-browser/extension test
pnpm --filter @bb-browser/extension build
rg -n "SSEClient|sendResult|upstreamUrl|19824|/result" packages/extension/src packages/extension/manifest.json
~~~

Expected: tests/build PASS；rg returns no matches。

- [ ] **Step 8: 提交扩展迁移**

~~~bash
git add packages/extension pnpm-lock.yaml
git commit -m "feat(extension): use Chrome native messaging"
~~~

---

### Task 7: 抽取站点适配器核心并支持工作流租约

**Files:**
- Create: packages/sites/package.json
- Create: packages/sites/tsconfig.json
- Create: packages/sites/tsup.config.ts
- Create: packages/sites/src/registry.ts
- Create: packages/sites/src/argument-map.ts
- Create: packages/sites/src/runner.ts
- Create: packages/sites/src/service.ts
- Create: packages/sites/src/index.ts
- Create: packages/sites/src/registry.test.ts
- Create: packages/sites/src/runner.test.ts

**Interfaces:**
- Consumes: BrowserClient.command、BrowserClient.withTabLease、adapter JS files under ~/.bb-browser/sites and ~/.bb-browser/bb-sites。
- Produces: SiteRegistry、SiteRunner、SiteService。

- [ ] **Step 1: 编写 Registry 失败测试**

Use temporary local/community directories containing two adapters with the same name. Assert local wins, metadata includes capabilities/readOnly/example, search matches name/description/domain, and malformed metadata is ignored with a structured diagnostic.

~~~ts
test("local adapters override community adapters", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bb-sites-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const localDir = join(root, "local");
  const communityDir = join(root, "community");
  await mkdir(localDir, { recursive: true });
  await mkdir(communityDir, { recursive: true });
  await writeFile(
    join(communityDir, "quote.js"),
    '/* @meta\n{"name":"stocks/quote","description":"community","domain":"example.com","args":{}}\n*/\nasync function(){return 1}',
  );
  await writeFile(
    join(localDir, "quote.js"),
    '/* @meta\n{"name":"stocks/quote","description":"local","domain":"example.com","args":{},"readOnly":true}\n*/\nasync function(){return 2}',
  );
  const registry = new SiteRegistry({ localDir, communityDir });
  assert.equal(registry.get("stocks/quote")?.description, "local");
  assert.equal(registry.search("example.com").length, 1);
});
~~~

- [ ] **Step 2: 编写 Runner 失败测试**

Use a FakeBrowserClient and assert:

- a matching x.com tab is reused;
- a missing tab opens https://x.com and is recorded by Broker ownership;
- withTabLease wraps eval for the selected tab;
- twitter/radar receives timeoutMs 120000 and idempotency unsafe_write;
- adapter error objects become adapter_execution_failed with phase adapter;
- missing required arguments fail before any browser command.

~~~ts
test("radar runs under a tab lease with a 120 second deadline", async () => {
  const client = new FakeBrowserClient({
    tabs: [{ tabId: 44, url: "https://x.com/i/radar" }],
    evalResult: JSON.stringify({ status: "ok", cleanup_status: "deleted" }),
  });
  const runner = new SiteRunner({
    client,
    registry: registryWithRadarAdapter(),
  });
  const result = await runner.run({
    name: "twitter/radar",
    namedArgs: { query: "NVDA" },
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(client.leaseCalls, [{ tabId: 44, timeoutMs: 120_000 }]);
  assert.equal(client.commandCalls.at(-1)?.options.idempotency, "unsafe_write");
  assert.equal(client.commandCalls.at(-1)?.options.timeoutMs, 120_000);
});
~~~

FakeBrowserClient and registryWithRadarAdapter are local test fixtures implementing the exact BrowserClient and SiteRegistry methods consumed by SiteRunner; they return deterministic data and record every call in arrays.

- [ ] **Step 3: 运行测试确认失败**

Run:

~~~bash
pnpm install
pnpm --filter @bb-browser/sites test
~~~

Expected: FAIL，SiteRegistry/SiteRunner 尚不存在。

- [ ] **Step 4: 实现 Registry 与参数映射**

Export:

~~~ts
export interface SiteMeta {
  name: string;
  description: string;
  domain: string;
  args: Record<string, { required?: boolean; description?: string }>;
  capabilities: string[];
  readOnly: boolean;
  example?: string;
  filePath: string;
  source: "local" | "community";
}

export class SiteRegistry {
  list(): SiteMeta[];
  search(query: string): SiteMeta[];
  get(name: string): SiteMeta | undefined;
  readSource(site: SiteMeta): string;
}
~~~

Move the existing @meta and legacy tag parsing from packages/cli/src/commands/site.ts into this package without retaining duplicate parsing in MCP.

- [ ] **Step 5: 实现 SiteRunner**

SiteRunner.run signature:

~~~ts
run(input: {
  name: string;
  args?: string[];
  namedArgs?: Record<string, string>;
  tabId?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<unknown>
~~~

Select or create the matching domain tab, then call client.withTabLease. Build the adapter wrapper with string concatenation so that the adapter resolves its async result and returns JSON. Use 120000 ms for twitter/radar and 60000 ms for other adapters unless the caller requests a lower deadline.

- [ ] **Step 6: 实现 SiteService**

SiteService exposes list、search、info、recommend、run、update. recommend uses the browser history action rather than packages/cli history-sqlite. update may run git clone/pull because it manages adapter files, but must not start or call a browser CLI.

- [ ] **Step 7: 运行测试和构建**

Run:

~~~bash
pnpm --filter @bb-browser/sites test
pnpm --filter @bb-browser/sites build
~~~

Expected: all sites tests PASS。

- [ ] **Step 8: 提交站点核心**

~~~bash
git add packages/sites pnpm-lock.yaml
git commit -m "refactor(sites): extract adapter service"
~~~

---

### Task 8: 将 MCP 缩减为薄 Adapter

**Files:**
- Create: packages/mcp/src/result.ts
- Create: packages/mcp/src/browser-tools.ts
- Create: packages/mcp/src/site-tools.ts
- Create: packages/mcp/src/server.ts
- Create: packages/mcp/src/server.test.ts
- Modify: packages/mcp/src/index.ts
- Modify: packages/mcp/package.json

**Interfaces:**
- Consumes: BrowserClient、SiteService。
- Produces: createMcpServer、startMcpServer and unchanged MCP tool contracts。

- [ ] **Step 1: 编写工具映射失败测试**

Inject FakeBrowserClient and FakeSiteService into createMcpServer. Assert exported handler maps:

~~~ts
await handlers.browser_open({ url: "https://example.com" });
~~~

to:

~~~ts
client.command(
  { action: "open", url: "https://example.com" },
  { timeoutMs: 60_000, idempotency: "safe_write" },
);
~~~

Assert browser_close_all calls client.closeOwnedTabs, site_run delegates to SiteService.run, and a ProtocolError keeps code、phase、retryable、error、hint、action in returned MCP text.

- [ ] **Step 2: 运行测试确认失败**

Run:

~~~bash
pnpm install
pnpm --filter @bb-browser/mcp test
~~~

Expected: FAIL，createMcpServer/handlers 尚未抽取。

- [ ] **Step 3: 实现 result.ts**

Export:

~~~ts
export function textResult(value: unknown): McpToolResult;
export function imageResult(dataUrl: string): McpToolResult;
export function protocolErrorResult(error: ProtocolError): McpToolResult;
~~~

protocolErrorResult must serialize every structured field and set isError true; it must never emit Failed to start daemon。

- [ ] **Step 4: 拆分浏览器与站点工具**

browser-tools.ts exports registerBrowserTools(server, client) and createBrowserToolHandlers(client). Keep all current tool names and Zod input schemas. Map action idempotency as:

- read: snapshot、get、tab_list、network requests、console get、errors get、history;
- safe_write: open a new tab、tab_new、wait、clear-only debug state;
- unsafe_write: click、fill、type、press、eval、route、dialog、close。

site-tools.ts exports registerSiteTools(server, service). Remove openclaw option and every CLI subprocess branch.

- [ ] **Step 5: 实现 server.ts 与最小 index.ts**

~~~ts
export function createMcpServer(
  client: BrowserClient,
  sites: SiteService,
): McpServer;

export async function startMcpServer(): Promise<void> {
  const client = await BrowserClient.connect({ clientName: "bb-browser-mcp" });
  const sites = new SiteService({ client });
  const server = createMcpServer(client, sites);
  await server.connect(new StdioServerTransport());
}
~~~

index.ts only calls startMcpServer and reports startup errors to stderr.

- [ ] **Step 6: 验证 MCP 不含旧依赖路径**

Run:

~~~bash
pnpm --filter @bb-browser/mcp test
pnpm --filter @bb-browser/mcp build
rg -n "ensureDaemon|DAEMON_BASE_URL|spawn|execFile|runSiteCli|sessionOpenedTabs|19824" packages/mcp/src
~~~

Expected: tests/build PASS；rg returns no matches。

- [ ] **Step 7: 提交 MCP Adapter**

~~~bash
git add packages/mcp pnpm-lock.yaml
git commit -m "refactor(mcp): use browser client SDK"
~~~

---

### Task 9: 增加 Native Host 安装器和 Codex Plugin 包装

**Files:**
- Create: scripts/install-native-host.mjs
- Create: scripts/uninstall-native-host.mjs
- Create: scripts/native-host-install.test.mjs
- Create: .codex-plugin/plugin.json
- Create: .mcp.json
- Create: .agents/plugins/marketplace.json
- Create: bin/bb-browser-mcp
- Modify: skills/bb-browser/SKILL.md
- Delete: skills/bb-browser-openclaw/SKILL.md
- Modify: package.json
- Modify: tsup.config.ts

**Interfaces:**
- Consumes: dist/native-host.js、dist/mcp.js、fixed extension ID ncpkoaiijcnacllhjjjfonmbhflmbnii。
- Produces: user-level Native Host installation and installable bb-browser@pinohouse Plugin。

- [ ] **Step 1: 编写安装器失败测试**

Run installer with temporary roots and assert:

- native-host.js copied under Application Support/bb-browser/native-host;
- executable launcher contains the current process.execPath;
- auth-token exists with mode 0600;
- com.pinix.bb_browser.json contains an absolute launcher path;
- allowed_origins equals chrome-extension://ncpkoaiijcnacllhjjjfonmbhflmbnii/;
- a second install atomically replaces files without changing the token;
- uninstaller removes manifest/host/socket but leaves unrelated files.

~~~js
test("installer writes a stable user-level native host", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bb-native-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appRoot = join(root, "app");
  const chromeRoot = join(root, "chrome");
  const source = join(root, "native-host.js");
  await writeFile(source, "process.exit(0);");
  await installNativeHost({ appRoot, chromeRoot, source, nodePath: process.execPath });
  const manifestPath = join(
    chromeRoot,
    "NativeMessagingHosts",
    "com.pinix.bb_browser.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.deepEqual(manifest.allowed_origins, [
    "chrome-extension://ncpkoaiijcnacllhjjjfonmbhflmbnii/",
  ]);
  assert.equal(isAbsolute(manifest.path), true);
  const tokenPath = join(appRoot, "auth-token");
  const firstToken = await readFile(tokenPath, "utf8");
  assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
  await installNativeHost({ appRoot, chromeRoot, source, nodePath: process.execPath });
  assert.equal(await readFile(tokenPath, "utf8"), firstToken);
});
~~~

- [ ] **Step 2: 运行测试确认失败**

Run:

~~~bash
node --test scripts/native-host-install.test.mjs
~~~

Expected: FAIL，installer files 尚不存在。

- [ ] **Step 3: 实现用户级安装器**

Default paths:

~~~js
const appRoot = join(
  homedir(),
  "Library",
  "Application Support",
  "bb-browser",
);
const chromeManifest = join(
  homedir(),
  "Library",
  "Application Support",
  "Google",
  "Chrome",
  "NativeMessagingHosts",
  "com.pinix.bb_browser.json",
);
~~~

Manifest body:

~~~json
{
  "name": "com.pinix.bb_browser",
  "description": "bb-browser native broker",
  "path": "/absolute/user/path/to/bb-browser-native-host",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://ncpkoaiijcnacllhjjjfonmbhflmbnii/"
  ]
}
~~~

Write files through temporary siblings and rename atomically. Generate auth token with randomBytes(32).toString("hex") only if it does not already exist.

- [ ] **Step 4: 增加 Plugin 清单**

.codex-plugin/plugin.json:

~~~json
{
  "name": "bb-browser",
  "version": "0.11.0",
  "description": "Control the user's real Chrome with session-safe browser tools and site adapters.",
  "author": {
    "name": "PinoHouse"
  },
  "homepage": "https://github.com/PinoHouse/bb-browser",
  "repository": "https://github.com/PinoHouse/bb-browser",
  "license": "MIT",
  "keywords": [
    "browser",
    "chrome",
    "automation",
    "site-adapters"
  ],
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "interface": {
    "displayName": "bb-browser",
    "shortDescription": "Control your signed-in Chrome",
    "longDescription": "Use structured browser tools and site adapters against the user's real signed-in Chrome with multi-session isolation.",
    "developerName": "PinoHouse",
    "category": "Developer Tools",
    "capabilities": [
      "Interactive",
      "Read",
      "Write"
    ],
    "defaultPrompt": [
      "Use my signed-in Chrome to inspect this page",
      "Run a bb-browser site adapter"
    ],
    "websiteURL": "https://github.com/PinoHouse/bb-browser",
    "brandColor": "#2563EB"
  }
}
~~~

.mcp.json:

~~~json
{
  "mcpServers": {
    "bb-browser": {
      "command": "./bin/bb-browser-mcp",
      "cwd": "."
    }
  }
}
~~~

bin/bb-browser-mcp:

~~~sh
#!/bin/sh
set -eu
PLUGIN_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$PLUGIN_ROOT/dist/mcp.js"
~~~

Mark the launcher executable with chmod 0755.

.agents/plugins/marketplace.json:

~~~json
{
  "name": "pinohouse",
  "interface": {
    "displayName": "PinoHouse"
  },
  "plugins": [
    {
      "name": "bb-browser",
      "source": {
        "source": "local",
        "path": "."
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Developer Tools"
    }
  ]
}
~~~

- [ ] **Step 5: 更新 Skill 边界**

Rewrite skills/bb-browser/SKILL.md so that:

- remove the allowed-tools: Bash(bb-browser:*) frontmatter key; the body states that only mcp__bb_browser__* tools are permitted;
- it explicitly forbids CLI、daemon、Playwright and alternative browser MCPs;
- it instructs callers to pass tab IDs and close only session-owned tabs;
- site_run is the only normal site-adapter execution path;
- broker_unavailable/extension_disconnected are infrastructure failures;
- adapter_execution_failed/request_deadline_exceeded apply only to the current item unless health also fails。

Remove the OpenClaw-only skill because the independent PinoHouse project no longer supports that transport.

- [ ] **Step 6: 更新构建入口和脚本**

Root tsup entries contain only:

~~~ts
{
  "native-host": "packages/broker/src/index.ts",
  "mcp": "packages/mcp/src/index.ts",
}
~~~

Do not retain a root cli entry.

Root scripts add:

~~~json
{
  "install:native-host": "node scripts/install-native-host.mjs",
  "uninstall:native-host": "node scripts/uninstall-native-host.mjs",
  "test:native-host-install": "node --test scripts/native-host-install.test.mjs"
}
~~~

Bump root/plugin/extension versions to 0.11.0.
Set root engines.node to >=20.0.0 because the Native Broker is built and tested against Node 20+.

- [ ] **Step 7: 运行安装器与 Plugin 静态验证**

Run:

~~~bash
pnpm build
pnpm test:native-host-install
node -e 'JSON.parse(require("node:fs").readFileSync(".codex-plugin/plugin.json","utf8")); JSON.parse(require("node:fs").readFileSync(".mcp.json","utf8")); JSON.parse(require("node:fs").readFileSync(".agents/plugins/marketplace.json","utf8"));'
~~~

Expected: build/tests PASS，three JSON files parse successfully。

- [ ] **Step 8: 提交 Plugin 和安装器**

~~~bash
git add .codex-plugin .mcp.json .agents bin scripts skills package.json tsup.config.ts pnpm-lock.yaml
git commit -m "feat(plugin): package native browser integration"
~~~

---

### Task 10: 删除旧 daemon 与浏览器 CLI 路径

**Files:**
- Delete: packages/daemon
- Delete: packages/cli
- Delete: bin/bb-browserd.ts
- Delete: packages/shared/src/constants.ts
- Modify: packages/shared/src/protocol.ts
- Modify: packages/shared/src/index.ts
- Modify: package.json
- Modify: pnpm-workspace.yaml
- Modify: README.md
- Modify: README.zh-CN.md
- Modify: AGENTS.md

**Interfaces:**
- Consumes: 已通过 Client SDK、Broker、Sites 和 MCP 替代的所有旧功能。
- Produces: 没有 daemon/SSE/TCP browser execution path 的最终仓库。

- [ ] **Step 1: 建立旧符号拒绝检查**

Run before deletion and record that it currently finds matches:

~~~bash
rg -n "DAEMON_|daemon|SSEClient|/command|/result|19824|BB_VIA_EXTENSION|BB_DAEMON_" packages package.json README.md README.zh-CN.md AGENTS.md
~~~

Expected: matches in legacy packages and docs。

- [ ] **Step 2: 删除已替代实现**

Delete packages/daemon、packages/cli、bin/bb-browserd.ts and old extension transport files. Root package bin exposes only bb-browser-mcp; Native Host installation remains a package script rather than a general CLI.

Remove SSEEvent、SSEEventType and DaemonStatus from the shared protocol, delete all DAEMON_*、SSE_* and COMMAND_TIMEOUT constants, and retain only browser action/data types plus the v2 protocol.

Set the root package executable and release files to:

~~~json
{
  "bin": {
    "bb-browser-mcp": "./dist/mcp.js"
  },
  "files": [
    ".codex-plugin",
    ".mcp.json",
    ".agents/plugins",
    "bin/bb-browser-mcp",
    "dist",
    "extension",
    "skills",
    "scripts/install-native-host.mjs",
    "scripts/uninstall-native-host.mjs",
    "README.md",
    "LICENSE"
  ]
}
~~~

Remove @bufbuild/protobuf、@connectrpc/connect、@connectrpc/connect-node and ws from root dependencies after rg confirms no remaining imports.

Before deleting packages/cli/src/client.ts, confirm commit from Task 1 exists and document the replacement mapping in the migration section of README:

- BB_VIA_EXTENSION -> always uses Plugin MCP Adapter;
- BB_DAEMON_HOST/PORT -> BB_BROWSER_SOCKET_PATH;
- fixed 60 second timeout -> per-operation deadline, Radar 120 seconds。

- [ ] **Step 3: 更新文档和仓库指南**

README quick start must contain:

1. build;
2. pnpm install:native-host;
3. load packages/extension/dist in chrome://extensions;
4. add PinoHouse marketplace;
5. install bb-browser@pinohouse;
6. restart Codex once。

AGENTS.md architecture diagram must show Plugin MCP Adapter -> Unix socket -> Native Broker Host -> Native Messaging -> Chrome Extension. Remove instructions that require five CLI/daemon edits for a new command.

- [ ] **Step 4: 运行拒绝检查、测试和构建**

Run:

~~~bash
rg -n "DAEMON_|ensureDaemon|SSEClient|/result|localhost:19824|BB_VIA_EXTENSION|BB_DAEMON_" packages package.json
pnpm test
pnpm build
git diff --check
~~~

Expected: rg returns no matches；all tests/build PASS；git diff --check has no output。

- [ ] **Step 5: 提交旧架构移除**

~~~bash
git add -A
git commit -m "refactor: remove daemon browser transport"
~~~

---

### Task 11: 安装并进行真实 Chrome 并发验收

**Files:**
- Create: scripts/mcp-smoke.mjs
- Create: scripts/concurrency-smoke.mjs
- Runtime state: ~/Library/Application Support/bb-browser
- Chrome manifest: ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.pinix.bb_browser.json
- Codex marketplace/plugin cache and config

**Interfaces:**
- Consumes: built Plugin、Native Host、extension。
- Produces: installed bb-browser Plugin and evidence that multiple clients share one Chrome safely。

- [ ] **Step 1: 安装 Native Host**

Run:

~~~bash
pnpm build
pnpm install:native-host
~~~

Verify manifest path、allowed_origins、launcher executable bit and token mode without printing token contents.

- [ ] **Step 2: 让用户重新加载扩展**

Open chrome://extensions manually, remove the old bb-browser unpacked extension if its ID differs, load packages/extension/dist, and verify displayed ID is ncpkoaiijcnacllhjjjfonmbhflmbnii. This is the only unavoidable manual browser step; do not use another browser automation tool.

- [ ] **Step 3: 安装本地 Codex Plugin**

Run:

~~~bash
codex plugin marketplace add /Users/lawrance/Desktop/workspace/bb-browser --json
codex plugin add bb-browser@pinohouse --json
~~~

Remove the legacy [mcp_servers.bb-browser] command/args block from ~/.codex/config.toml only after plugin installation succeeds. Restart Codex once so new tasks load the Plugin.

- [ ] **Step 4: 验证 Broker 健康与基础命令**

Create scripts/mcp-smoke.mjs using the MCP SDK client:

~~~js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/mcp.js"],
});
const client = new Client({ name: "bb-browser-smoke", version: "1.0.0" });
await client.connect(transport);
const tabs = await client.callTool({ name: "browser_tab_list", arguments: {} });
if (tabs.isError) throw new Error(JSON.stringify(tabs.content));
const opened = await client.callTool({
  name: "browser_open",
  arguments: { url: "https://example.com" },
});
if (opened.isError) throw new Error(JSON.stringify(opened.content));
const snapshot = await client.callTool({
  name: "browser_snapshot",
  arguments: { interactive: true },
});
if (snapshot.isError) throw new Error(JSON.stringify(snapshot.content));
const closed = await client.callTool({
  name: "browser_close_all",
  arguments: {},
});
if (closed.isError) throw new Error(JSON.stringify(closed.content));
await client.close();
~~~

Run:

~~~bash
node scripts/mcp-smoke.mjs
~~~

Expected:

- extensionConnected true;
- no dist/daemon.js process;
- no listener on TCP 19824;
- close_all closes only the test session tab。

- [ ] **Step 5: 验证三客户端并发**

Create scripts/concurrency-smoke.mjs with a createClient(name) helper using the same SDK/stdio transport as mcp-smoke.mjs. Start three clients and perform:

- client A opens example.com;
- client B opens x.com/i/radar;
- client C opens a third page;
- issue concurrent snapshots on all three;
- client A initializes window.__bb_order on A's tab, then clients A/C concurrently issue eval calls on that same explicit tab; the first eval waits 500 ms and pushes A, the second pushes C; assert the second result is ["A","C"];
- disconnect B and assert A/C continue。

Logs must identify requestId/sessionId/tabId and timing but contain no page text, cookies or command payload.

Run:

~~~bash
node scripts/concurrency-smoke.mjs
~~~

Expected: script prints PASS with three session IDs, three distinct owned tabs, and ordered same-tab result ["A","C"]。

- [ ] **Step 6: 运行最终自动化验证**

Run once against the final unchanged diff:

~~~bash
pnpm test
pnpm build
git diff --check
git status --short
~~~

Expected: tests/build PASS；only explicitly documented runtime artifacts remain outside git；working tree contains no unintended changes。

- [ ] **Step 7: 提交真实验收脚本**

~~~bash
git add scripts/mcp-smoke.mjs scripts/concurrency-smoke.mjs
git commit -m "test(e2e): add plugin concurrency smoke"
~~~

---

### Task 12: 修复 CashMaker Radar 策略并回填上一次报告

**Files:**
- Modify if policy still has the old breaker: /Users/lawrance/Desktop/workspace/CashMaker/.agents/skills/report/SKILL.md
- Update runtime report: /Users/lawrance/.cashmaker/reports/2026-08-26-portfolio-report.md
- Update the existing Notion report page when the Notion connection remains authorized

**Interfaces:**
- Consumes: installed mcp__bb_browser__site_run、twitter/radar adapter、CashMaker report workflow。
- Produces: all 23 symbols attempted, accurate failure classification, updated report and Notion page。

- [ ] **Step 1: 更新报告故障分类**

Ensure the report Skill contains these exact rules:

- Global infrastructure stop: broker_unavailable、extension_disconnected、protocol_version_mismatch。
- Current-symbol failure and continue: adapter_execution_failed、request_deadline_exceeded、tab_lease_timeout、browser_command_failed。
- Adapter-returned statuses retain status、phase、reason_code、retryable、cleanup_status。
- Never translate a transport timeout into adapter_runtime_incompatible。

If the file changes, run its existing structural checks and commit only that file with:

~~~bash
git add .agents/skills/report/SKILL.md
git commit -m "fix(report): isolate browser adapter failures"
~~~

- [ ] **Step 2: 预检 X Radar**

Sequentially call twitter/radar with action check. Expected status ready. If not ready, record the precise typed error and stop the report rerun without overwriting the previous successful sections.

- [ ] **Step 3: 顺序扫描 23 只股票**

Run the report Skill's X Radar requests sequentially through the new Plugin. Do not parallelize site_run. For every symbol, record either a complete result or its typed failure. A symbol failure must not mark the remaining symbols unscanned.

Acceptance:

- attempted count equals 23;
- skipped_after_global_failure equals 0 unless Broker/extension/protocol actually failed;
- every temporary Radar rule reports cleanup_status deleted or is explicitly listed for manual cleanup。

- [ ] **Step 4: 更新本地与 Notion 报告**

Regenerate the X 关注与讨论 section and its totals from observed results. Replace the old MSFT adapter_runtime_incompatible record and remove the false global-failure skip entries. Preserve all unrelated portfolio、valuation、trade and performance content.

Update the existing Notion page rather than creating a duplicate. HTML attachment remains optional and is not required for report correctness.

- [ ] **Step 5: 最终核对**

Verify:

- local Markdown and Notion show the same attempted/success/failure counts;
- NVDA and every other success contain the actual observation time and source;
- no claim is inferred from missing Radar data;
- the report explicitly distinguishes browser infrastructure errors from X adapter/domain errors。

---

## Final Delivery Evidence

Before declaring completion, provide:

- bb-browser commit list from Task 1 through Task 10;
- one full pnpm test and pnpm build result from the final diff;
- fixed extension ID and installed Native Host manifest location;
- proof that no daemon process/TCP 19824 dependency remains;
- three-client concurrency test result;
- X Radar attempted/success/failure/cleanup totals for all 23 symbols;
- links to the updated local report and the existing Notion page。
