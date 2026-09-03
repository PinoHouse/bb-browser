import type { CommandInput, CommandOptions } from "@bb-browser/client";
import {
  createProtocolError,
  type CommandResponse,
  type TabInfo,
} from "@bb-browser/shared";
import { mapSiteArguments } from "./argument-map.js";
import { SiteRegistry, type SiteMeta } from "./registry.js";

export interface BrowserClientLike {
  readonly connectionGeneration?: number;
  ensureConnected?(timeoutMs?: number, signal?: AbortSignal): Promise<void>;
  command(
    input: CommandInput,
    options: CommandOptions,
  ): Promise<CommandResponse>;
  withTabLease<T>(
    tabId: number,
    timeoutMs: number,
    work: (leaseId: string) => Promise<T>,
    options?: { signal?: AbortSignal; connectionGeneration?: number },
  ): Promise<T>;
}

export interface SiteRunnerOptions {
  client: BrowserClientLike;
  registry: SiteRegistry;
}

export class SiteRunner {
  constructor(private readonly options: SiteRunnerOptions) {}

  async run(input: {
    name: string;
    args?: string[];
    namedArgs?: Record<string, string>;
    tabId?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<unknown> {
    const site = this.options.registry.get(input.name);
    if (!site) {
      const suggestions = this.options.registry
        .search(input.name)
        .slice(0, 5)
        .map((candidate) => candidate.name);
      const error = createProtocolError(
        "adapter_execution_failed",
        "adapter",
        `Adapter "${input.name}" not found`,
        { retryable: false, action: input.name },
      );
      error.hint = suggestions.length
        ? `可能是：${suggestions.join(", ")}`
        : "请先更新 bb-sites adapter 库";
      throw error;
    }

    const args = mapSiteArguments(site, input.args, input.namedArgs);
    const defaultTimeoutMs = site.name === "twitter/radar" ? 120_000 : 60_000;
    const timeoutMs = Math.min(
      defaultTimeoutMs,
      Math.max(1, input.timeoutMs ?? defaultTimeoutMs),
    );
    const deadline = Date.now() + timeoutMs;
    await this.options.client.ensureConnected?.(
      remaining(deadline),
      input.signal,
    );
    const generation = this.options.client.connectionGeneration;
    const tabId = await this.resolveTab(
      site,
      input.tabId,
      deadline,
      input.signal,
      generation,
    );
    this.checkGeneration(generation);
    const source = this.options.registry.readSource(site);
    const body = source.replace(/\/\*\s*@meta[\s\S]*?\*\//, "").trim();
    const script =
      `const __bb_fn = ${body};\n` +
      `const __bb_r = await __bb_fn(${JSON.stringify(args)});\n` +
      "JSON.stringify(__bb_r);";

    return this.options.client.withTabLease(
      tabId,
      remaining(deadline),
      async (leaseId) => {
        const response = await this.options.client.command(
          { action: "eval", script, tabId },
          {
            timeoutMs: remaining(deadline),
            idempotency: site.readOnly ? "read" : "unsafe_write",
            signal: input.signal,
            leaseId,
            connectionGeneration: generation,
          },
        );
        return this.parseResult(site, response.data?.result);
      },
      { signal: input.signal, connectionGeneration: generation },
    );
  }

  private async resolveTab(
    site: SiteMeta,
    requestedTabId: number | undefined,
    deadline: number,
    signal?: AbortSignal,
    generation?: number,
  ): Promise<number> {
    if (requestedTabId !== undefined) {
      return requestedTabId;
    }
    const listResponse = await this.options.client.command(
      { action: "tab_list" },
      {
        timeoutMs: Math.min(remaining(deadline), 30_000),
        idempotency: "read",
        signal,
        connectionGeneration: generation,
      },
    );
    const tabs = listResponse.data?.tabs ?? [];
    this.checkGeneration(generation);
    const matching = site.domain
      ? tabs.find((tab) => matchesDomain(tab, site.domain))
      : (tabs.find((tab) => tab.active) ?? tabs[0]);
    if (matching) {
      return matching.tabId;
    }
    if (!site.domain) {
      throw createProtocolError(
        "tab_not_found",
        "adapter",
        `没有可用于 ${site.name} 的 Chrome 标签页`,
        { retryable: true, action: site.name },
      );
    }
    const opened = await this.options.client.command(
      { action: "tab_new", url: `https://${site.domain}` },
      {
        timeoutMs: Math.min(remaining(deadline), 60_000),
        idempotency: "safe_write",
        signal,
        connectionGeneration: generation,
      },
    );
    if (opened.data?.tabId === undefined) {
      throw createProtocolError(
        "browser_command_failed",
        "execute",
        `无法为 ${site.name} 创建标签页`,
        { retryable: true, action: site.name },
      );
    }
    return opened.data.tabId;
  }

  private checkGeneration(expected?: number): void {
    if (
      expected !== undefined &&
      expected !== this.options.client.connectionGeneration
    ) {
      throw createProtocolError(
        "session_reset",
        "adapter",
        "浏览器连接已变化，请重新检查页面后运行适配器",
        { retryable: false },
      );
    }
  }

  private parseResult(site: SiteMeta, result: unknown): unknown {
    if (result === undefined || result === null) {
      return null;
    }
    let parsed = result;
    if (typeof result === "string") {
      try {
        parsed = JSON.parse(result);
      } catch {
        parsed = result;
      }
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "string"
    ) {
      const error = createProtocolError(
        "adapter_execution_failed",
        "adapter",
        parsed.error,
        { retryable: false, action: site.name },
      );
      if ("hint" in parsed && typeof parsed.hint === "string") {
        error.hint = parsed.hint;
      }
      throw error;
    }
    return parsed;
  }
}

function matchesDomain(tab: TabInfo, domain: string): boolean {
  try {
    const hostname = new URL(tab.url).hostname;
    return hostname === domain || hostname.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

function remaining(deadline: number): number {
  const ms = deadline - Date.now();
  if (ms <= 0)
    throw createProtocolError(
      "request_deadline_exceeded",
      "adapter",
      "适配器已超过原始截止时间",
      { retryable: false },
    );
  return ms;
}
