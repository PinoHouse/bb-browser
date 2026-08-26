import { startMcpServer } from "./server.js";

export { createMcpServer, startMcpServer } from "./server.js";
export { createBrowserToolHandlers } from "./browser-tools.js";
export { createSiteToolHandlers } from "./site-tools.js";

void startMcpServer().catch((error) => {
  process.stderr.write(
    `[bb-browser] MCP startup failed: ${
      error instanceof Error ? error.message : JSON.stringify(error)
    }\n`,
  );
  process.exitCode = 1;
});
