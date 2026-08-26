import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface RuntimePathOptions {
  runtimeRoot?: string;
  configRoot?: string;
}

export function getRuntimePaths(options: RuntimePathOptions = {}) {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const runtimeRoot = options.runtimeRoot ?? join(tmpdir(), `bb-browser-${uid}`);
  const configRoot =
    options.configRoot ??
    join(homedir(), "Library", "Application Support", "bb-browser");

  return {
    runtimeRoot,
    socketPath:
      process.env.BB_BROWSER_SOCKET_PATH ?? join(runtimeRoot, "broker.sock"),
    tokenPath: join(configRoot, "auth-token"),
  };
}
