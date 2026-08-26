import test from "node:test";
import assert from "node:assert/strict";
import { ResourceScheduler } from "./resource-scheduler.js";

test("same tab is serialized while different tabs run concurrently", async () => {
  const scheduler = new ResourceScheduler();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = scheduler.run("session-a", "tab:1", async () => {
    events.push("a:start");
    await gate;
    events.push("a:end");
  });
  const second = scheduler.run("session-b", "tab:1", async () => {
    events.push("b:start");
  });
  const parallel = scheduler.run("session-c", "tab:2", async () => {
    events.push("c:start");
  });

  await parallel;
  assert.deepEqual(events, ["a:start", "c:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["a:start", "c:start", "a:end", "b:start"]);
});

test("queued sessions are served round-robin", async () => {
  const scheduler = new ResourceScheduler();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = scheduler.run("session-a", "tab:1", async () => {
    order.push("a1");
    await gate;
  });
  const secondA = scheduler.run("session-a", "tab:1", async () => {
    order.push("a2");
  });
  const firstB = scheduler.run("session-b", "tab:1", async () => {
    order.push("b1");
  });
  release();
  await Promise.all([first, secondA, firstB]);
  assert.deepEqual(order, ["a1", "b1", "a2"]);
});
