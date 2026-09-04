import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SiteRegistry } from "./registry.js";

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
  await writeFile(join(localDir, "broken.js"), "/* @meta\n{broken}\n*/");
  const registry = new SiteRegistry({ localDir, communityDir });
  assert.equal(registry.get("stocks/quote")?.description, "local");
  assert.equal(registry.search("example.com").length, 1);
  assert.equal(registry.get("stocks/quote")?.readOnly, true);
  assert.equal(registry.diagnostics.length, 1);
});

test("underscore files are shared helpers, not adapters, and resolve per platform", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bb-sites-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const localDir = join(root, "local");
  const communityDir = join(root, "community");
  await mkdir(join(localDir, "twitter"), { recursive: true });
  await mkdir(join(communityDir, "twitter"), { recursive: true });
  await mkdir(join(communityDir, "reddit"), { recursive: true });
  const adapter = (name: string) =>
    `/* @meta\n{"name":"${name}","description":"","domain":"example.com","args":{}}\n*/\nasync function(){return 1}`;
  await writeFile(join(communityDir, "twitter", "_helper.js"), "function findGraphQLQueryId(){}");
  await writeFile(join(communityDir, "twitter", "search.js"), adapter("twitter/search"));
  await writeFile(join(localDir, "twitter", "radar.js"), adapter("twitter/radar"));
  await writeFile(join(communityDir, "reddit", "hot.js"), adapter("reddit/hot"));
  const registry = new SiteRegistry({ localDir, communityDir });

  assert.deepEqual(
    registry.list().map((site) => site.name).sort(),
    ["reddit/hot", "twitter/radar", "twitter/search"],
  );
  assert.equal(registry.readHelper(registry.get("twitter/search")!), "function findGraphQLQueryId(){}");
  assert.equal(registry.readHelper(registry.get("twitter/radar")!), "function findGraphQLQueryId(){}");
  assert.equal(registry.readHelper(registry.get("reddit/hot")!), null);
});
