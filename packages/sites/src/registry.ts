import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

export interface SiteArgDefinition {
  required?: boolean;
  description?: string;
}

export interface SiteMeta {
  name: string;
  description: string;
  domain: string;
  args: Record<string, SiteArgDefinition>;
  capabilities: string[];
  readOnly: boolean;
  example?: string;
  filePath: string;
  source: "local" | "community";
}

export interface SiteDiagnostic {
  code: "adapter_read_failed" | "adapter_metadata_invalid";
  filePath: string;
  source: "local" | "community";
  message: string;
}

export interface SiteRegistryOptions {
  localDir?: string;
  communityDir?: string;
}

export class SiteRegistry {
  readonly localDir: string;
  readonly communityDir: string;
  private sites = new Map<string, SiteMeta>();
  private diagnosticList: SiteDiagnostic[] = [];

  constructor(options: SiteRegistryOptions = {}) {
    const root = join(homedir(), ".bb-browser");
    this.localDir = options.localDir ?? join(root, "sites");
    this.communityDir = options.communityDir ?? join(root, "bb-sites");
    this.refresh();
  }

  refresh(): void {
    this.diagnosticList = [];
    const byName = new Map<string, SiteMeta>();
    for (const site of this.scan(this.communityDir, "community")) {
      byName.set(site.name, site);
    }
    for (const site of this.scan(this.localDir, "local")) {
      byName.set(site.name, site);
    }
    this.sites = byName;
  }

  list(): SiteMeta[] {
    return [...this.sites.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  search(query: string): SiteMeta[] {
    const normalized = query.toLowerCase();
    return this.list().filter(
      (site) =>
        site.name.toLowerCase().includes(normalized) ||
        site.description.toLowerCase().includes(normalized) ||
        site.domain.toLowerCase().includes(normalized),
    );
  }

  get(name: string): SiteMeta | undefined {
    return this.sites.get(name);
  }

  readSource(site: SiteMeta): string {
    return readFileSync(site.filePath, "utf8");
  }

  /**
   * Shared helpers live in `_helper.js` next to the adapter and are prepended
   * to its evaluation scope. A local override that ships no helper of its own
   * falls back to the community helper for the same platform directory, so
   * overriding one adapter never silently drops the shared code.
   */
  readHelper(site: SiteMeta): string | null {
    const adapterDir = dirname(site.filePath);
    const candidates = [join(adapterDir, "_helper.js")];
    if (site.source === "local") {
      const platformDir = relative(this.localDir, adapterDir);
      if (platformDir && !platformDir.startsWith("..")) {
        candidates.push(join(this.communityDir, platformDir, "_helper.js"));
      }
    }
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return readFileSync(candidate, "utf8");
      }
    }
    return null;
  }

  get diagnostics(): readonly SiteDiagnostic[] {
    return this.diagnosticList;
  }

  private scan(
    root: string,
    source: "local" | "community",
  ): SiteMeta[] {
    if (!existsSync(root)) {
      return [];
    }
    const sites: SiteMeta[] = [];
    const walk = (directory: string): void => {
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch (error) {
        this.diagnosticList.push({
          code: "adapter_read_failed",
          filePath: directory,
          source,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      for (const entry of entries) {
        const filePath = join(directory, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          walk(filePath);
        } else if (
          entry.isFile() &&
          entry.name.endsWith(".js") &&
          // `_helper.js` and other underscore files are shared code, not adapters.
          !entry.name.startsWith("_")
        ) {
          const site = this.parse(filePath, root, source);
          if (site) {
            sites.push(site);
          }
        }
      }
    };
    walk(root);
    return sites;
  }

  private parse(
    filePath: string,
    root: string,
    source: "local" | "community",
  ): SiteMeta | null {
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (error) {
      this.diagnosticList.push({
        code: "adapter_read_failed",
        filePath,
        source,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const defaultName = relative(root, filePath)
      .replace(/\.js$/, "")
      .replace(/\\/g, "/");
    const metaMatch = content.match(/\/\*\s*@meta\s*([\s\S]*?)\*\//);
    if (metaMatch) {
      try {
        const raw = JSON.parse(metaMatch[1]) as Record<string, unknown>;
        return this.normalizeMeta(raw, defaultName, filePath, source);
      } catch (error) {
        this.diagnosticList.push({
          code: "adapter_metadata_invalid",
          filePath,
          source,
          message: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }
    return this.parseLegacy(content, defaultName, filePath, source);
  }

  private normalizeMeta(
    raw: Record<string, unknown>,
    defaultName: string,
    filePath: string,
    source: "local" | "community",
  ): SiteMeta {
    if (raw.args !== undefined && !isRecord(raw.args)) {
      throw new Error("Adapter metadata args must be an object");
    }
    const args: Record<string, SiteArgDefinition> = {};
    for (const [name, value] of Object.entries(raw.args ?? {})) {
      if (!isRecord(value)) {
        throw new Error(`Adapter argument ${name} must be an object`);
      }
      args[name] = {
        required: value.required === true,
        description:
          typeof value.description === "string"
            ? value.description
            : undefined,
      };
    }
    return {
      name: typeof raw.name === "string" ? raw.name : defaultName,
      description:
        typeof raw.description === "string" ? raw.description : "",
      domain: typeof raw.domain === "string" ? raw.domain : "",
      args,
      capabilities: Array.isArray(raw.capabilities)
        ? raw.capabilities.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      readOnly: raw.readOnly === true,
      example: typeof raw.example === "string" ? raw.example : undefined,
      filePath,
      source,
    };
  }

  private parseLegacy(
    content: string,
    defaultName: string,
    filePath: string,
    source: "local" | "community",
  ): SiteMeta {
    const site: SiteMeta = {
      name: defaultName,
      description: "",
      domain: "",
      args: {},
      capabilities: [],
      readOnly: false,
      filePath,
      source,
    };
    const pattern = /\/\/\s*@(\w+)[ \t]+(.*)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const key = match[1];
      const value = match[2].trim();
      if (key === "name") {
        site.name = value;
      } else if (key === "description") {
        site.description = value;
      } else if (key === "domain") {
        site.domain = value;
      } else if (key === "example") {
        site.example = value;
      } else if (key === "args") {
        for (const argument of value.split(/[,\s]+/).filter(Boolean)) {
          site.args[argument] = { required: true };
        }
      }
    }
    return site;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
