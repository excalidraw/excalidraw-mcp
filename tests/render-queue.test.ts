import assert from "node:assert/strict";
import { test } from "node:test";
import { createRenderQueue } from "../src/render-queue.js";

test("exports are serialized and obsolete pending scenes are coalesced", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const rendered: number[] = [];
  const queue = createRenderQueue((error) => { throw error; });
  const first = queue.enqueue(async () => { rendered.push(1); await gate; });
  queue.enqueue(async () => { rendered.push(2); });
  const last = queue.enqueue(async () => { rendered.push(3); });
  assert.deepEqual(rendered, [1]);
  release();
  await Promise.all([first, last]);
  assert.deepEqual(rendered, [1, 3]);
});

test("pending work can be cancelled and failures do not prevent the next export", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const errors: unknown[] = [];
  const rendered: number[] = [];
  const queue = createRenderQueue((error) => errors.push(error));
  const first = queue.enqueue(async () => { await gate; throw new Error("export failed"); });
  queue.enqueue(async () => { rendered.push(2); });
  queue.clear();
  release();
  await first;
  assert.equal(errors.length, 1);
  assert.equal(rendered.length, 0);
  await queue.enqueue(async () => { rendered.push(3); });
  assert.deepEqual(rendered, [3]);
});
