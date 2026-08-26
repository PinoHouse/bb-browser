import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createProtocolError } from "@bb-browser/shared";
import {
  SiteRegistry,
  type SiteMeta,
  type SiteRegistryOptions,
} from "./registry.js";
import {
  SiteRunner,
  type BrowserClientLike,
} from "./runner.js";

const DEFAULT_COMMUNITY_REPO = "https://github.com/epiral/bb-sites.git";

export interface SiteServiceOptions extends SiteRegistryOptions {
  client: BrowserClientLike;
  registry?: SiteRegistry;
  communityRepo?: string;
}

export interface SiteRecommendation {
  domain: string;
  visits: number;
  adapterCount: number;
  adapters: Array<{
    name: string;
    description: string;
    example: string;
  }>;
}

export class SiteService {
  readonly registry: SiteRegistry;
  private readonly runner: SiteRunner;
  private readonly client: BrowserClientLike;
  private readonly communityRepo: string;

  constructor(options: SiteServiceOptions) {
    this.client = options.client;
    this.registry =
      options.registry ??
      new SiteRegistry({
        localDir: options.localDir,
        communityDir: options.communityDir,
      });
    this.runner = new SiteRunner({
      client: options.client,
      registry: this.registry,
    });
    this.communityRepo = options.communityRepo ?? DEFAULT_COMMUNITY_REPO;
  }

  list(): SiteMeta[] {
    return this.registry.list();
  }

  search(query: string): SiteMeta[] {
    return this.registry.search(query);
  }

  info(name: string): SiteMeta {
    const site = this.registry.get(name);
    if (!site) {
      throw createProtocolError(
        "adapter_execution_failed",
        "adapter",
        `Adapter "${name}" not found`,
        { retryable: false, action: name },
      );
    }
    return site;
  }

  run(input: Parameters<SiteRunner["run"]>[0]): Promise<unknown> {
    return this.runner.run(input);
  }

  async recommend(days = 30): Promise<{
    days: number;
    available: SiteRecommendation[];
    not_available: Array<{ domain: string; visits: number }>;
  }> {
    const response = await this.client.command(
      { action: "history", historyCommand: "domains", ms: days },
      { timeoutMs: 60_000, idempotency: "read" },
    );
    const history = response.data?.historyDomains ?? [];
    const available: SiteRecommendation[] = [];
    const notAvailable: Array<{ domain: string; visits: number }> = [];
    const sites = this.registry.list();

    for (const item of history) {
      const adapters = sites.filter(
        (site) =>
          site.domain &&
          (item.domain === site.domain || item.domain.endsWith(`.${site.domain}`)),
      );
      if (adapters.length > 0) {
        available.push({
          domain: item.domain,
          visits: item.visits,
          adapterCount: adapters.length,
          adapters: adapters.map((site) => ({
            name: site.name,
            description: site.description,
            example: site.example ?? `site_run ${site.name}`,
          })),
        });
      } else if (
        item.visits >= 5 &&
        item.domain.includes(".") &&
        !item.domain.includes("localhost")
      ) {
        notAvailable.push({ domain: item.domain, visits: item.visits });
      }
    }
    return { days, available, not_available: notAvailable };
  }

  async update(): Promise<{
    success: true;
    updateMode: "clone" | "pull";
    communityRepo: string;
    communityDir: string;
    siteCount: number;
  }> {
    const communityDir = this.registry.communityDir;
    const updateMode = existsSync(join(communityDir, ".git"))
      ? "pull"
      : "clone";
    try {
      if (updateMode === "pull") {
        await runProcess("git", ["pull", "--ff-only"], communityDir);
      } else {
        await mkdir(dirname(communityDir), { recursive: true });
        await runProcess("git", ["clone", this.communityRepo, communityDir]);
      }
    } catch (error) {
      throw createProtocolError(
        "adapter_execution_failed",
        "adapter",
        error instanceof Error ? error.message : String(error),
        { retryable: true, action: "site_update" },
      );
    }
    this.registry.refresh();
    return {
      success: true,
      updateMode,
      communityRepo: this.communityRepo,
      communityDir,
      siteCount: this.registry.list().filter(
        (site) => site.source === "community",
      ).length,
    };
  }
}

async function runProcess(
  command: string,
  args: string[],
  cwd?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            stderr.trim() || `${command} exited with status ${String(code)}`,
          ),
        );
      }
    });
  });
}
