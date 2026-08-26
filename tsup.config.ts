import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  entry: {
    "native-host": "packages/broker/src/index.ts",
    mcp: "packages/mcp/src/index.ts",
  },
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  target: "node20",
  splitting: true,  // 共享代码会被提取到 chunk
  outDir: "dist",
  banner: {
    js: "#!/usr/bin/env node",
  },
  define: {
    __BB_BROWSER_VERSION__: JSON.stringify(packageJson.version),
  },
  // 全部 bundle 进去（npx 可用），只保留 ws（CommonJS 动态 require）
  noExternal: [/^(?!ws$).*/],
  external: ["ws"],
});
