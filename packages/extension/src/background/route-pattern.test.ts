import test from "node:test";
import assert from "node:assert/strict";
import { matchesRoutePattern } from "./cdp-service.js";

test("route patterns treat everything except * as literal text", () => {
  assert.equal(matchesRoutePattern("*", "https://x.com/anything"), true);
  assert.equal(matchesRoutePattern("api.example.com", "https://api.example.com/v1"), true);
  assert.equal(matchesRoutePattern("api.example.com", "https://apiXexample.com/v1"), false);
  assert.equal(matchesRoutePattern("*/graphql/*", "https://x.com/i/api/graphql/abc?x=1"), true);
  assert.equal(matchesRoutePattern("https://x.com/i/api/*.json", "https://x.com/i/api/data.json"), true);
  assert.equal(matchesRoutePattern("https://x.com/i/api/*.json", "https://x.com/i/api/dataXjson"), false);
  assert.equal(matchesRoutePattern("v1?x=1", "https://x.com/v1?x=1"), true);
  assert.equal(matchesRoutePattern("v1?x=1", "https://x.com/vx=1"), false);
});
