import { createProtocolError } from "@bb-browser/shared";
import type { SiteMeta } from "./registry.js";

export function mapSiteArguments(
  site: SiteMeta,
  positional: string[] = [],
  named: Record<string, string> = {},
): Record<string, string> {
  const names = Object.keys(site.args);
  const result: Record<string, string> = {};

  for (const [name, value] of Object.entries(named)) {
    if (!(name in site.args)) {
      throw argumentError(site, `unknown argument "${name}"`);
    }
    result[name] = value;
  }

  let position = 0;
  for (const name of names) {
    if (!(name in result) && position < positional.length) {
      result[name] = positional[position];
      position += 1;
    }
  }
  if (position < positional.length) {
    throw argumentError(site, "too many positional arguments");
  }
  for (const [name, definition] of Object.entries(site.args)) {
    if (definition.required && !result[name]) {
      throw argumentError(site, `missing required argument "${name}"`);
    }
  }
  return result;
}

function argumentError(site: SiteMeta, detail: string) {
  const error = createProtocolError(
    "adapter_execution_failed",
    "adapter",
    `${site.name}: ${detail}`,
    { retryable: false, action: site.name },
  );
  error.hint = site.example
    ? `示例：${site.example}`
    : `请检查 ${site.name} 的参数定义`;
  return error;
}
