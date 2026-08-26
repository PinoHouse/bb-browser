import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CommandResponse,
  Idempotency,
  Request,
} from "@bb-browser/shared";
import { SiteRegistry } from "./registry.js";
import { SiteRunner } from "./runner.js";

interface CommandCall {
  input: Omit<Request, "id">;
  options: {
    timeoutMs: number;
    idempotency: Idempotency;
    signal?: AbortSignal;
    leaseId?: string;
  };
}

class FakeBrowserClient {
  commandCalls: CommandCall[] = [];
  leaseCalls: Array<{ tabId: number; timeoutMs: number }> = [];

  constructor(
    private readonly fixture: {
      tabs: Array<{ tabId: number; url: string }>;
      evalResult: string;
    },
  ) {}

  async command(
    input: Omit<Request, "id">,
    options: CommandCall["options"],
  ): Promise<CommandResponse> {
    this.commandCalls.push({ input, options });
    const data =
      input.action === "tab_list"
        ? {
            tabs: this.fixture.tabs.map((tab, index) => ({
              ...tab,
              index,
              title: "",
              active: index === 0,
            })),
          }
        : input.action === "tab_new"
          ? { tabId: 99 }
          : { result: this.fixture.evalResult };
    return {
      kind: "command.response",
      protocolVersion: 2,
      requestId: `request-${this.commandCalls.length}`,
      sessionId: "session-1",
      success: true,
      data,
      timing: { queuedMs: 0, executionMs: 1 },
    };
  }

  async withTabLease<T>(
    tabId: number,
    timeoutMs: number,
    work: (leaseId: string) => Promise<T>,
  ): Promise<T> {
    this.leaseCalls.push({ tabId, timeoutMs });
    return work("lease-1");
  }
}

async function createRegistry(
  t: TestContext,
  args: Record<string, { required?: boolean }> = {
    query: { required: false },
  },
): Promise<SiteRegistry> {
  const root = await mkdtemp(join(tmpdir(), "bb-runner-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const localDir = join(root, "local");
  const communityDir = join(root, "community");
  await mkdir(localDir, { recursive: true });
  await mkdir(communityDir, { recursive: true });
  await writeFile(
    join(localDir, "radar.js"),
    `/* @meta\n${JSON.stringify({
      name: "twitter/radar",
      description: "radar",
      domain: "x.com",
      args,
      readOnly: false,
    })}\n*/\nasync function(args){return {status:"ok",query:args.query}}`,
  );
  return new SiteRegistry({ localDir, communityDir });
}

test("radar runs under a tab lease with a 120 second deadline", async (t) => {
  const registry = await createRegistry(t);
  const client = new FakeBrowserClient({
    tabs: [{ tabId: 44, url: "https://x.com/i/radar" }],
    evalResult: JSON.stringify({ status: "ok", cleanup_status: "deleted" }),
  });
  const runner = new SiteRunner({ client, registry });
  const result = (await runner.run({
    name: "twitter/radar",
    namedArgs: { query: "NVDA" },
  })) as { status: string };
  assert.equal(result.status, "ok");
  assert.deepEqual(client.leaseCalls, [{ tabId: 44, timeoutMs: 120_000 }]);
  assert.equal(client.commandCalls.at(-1)?.options.idempotency, "unsafe_write");
  assert.equal(client.commandCalls.at(-1)?.options.timeoutMs, 120_000);
  assert.equal(client.commandCalls.at(-1)?.options.leaseId, "lease-1");
});

test("missing required arguments fail before any browser command", async (t) => {
  const registry = await createRegistry(t, { query: { required: true } });
  const client = new FakeBrowserClient({ tabs: [], evalResult: "null" });
  const runner = new SiteRunner({ client, registry });
  await assert.rejects(
    runner.run({ name: "twitter/radar" }),
    (error: { code?: string; phase?: string }) =>
      error.code === "adapter_execution_failed" && error.phase === "adapter",
  );
  assert.equal(client.commandCalls.length, 0);
});
