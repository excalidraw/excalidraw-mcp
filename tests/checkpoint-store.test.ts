import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  CHECKPOINT_CAS_SCRIPT, CheckpointDataError, CheckpointLockError, CheckpointRevisionConflictError,
  createVercelStore, defaultCheckpointDirectory, FileCheckpointStore, LegacyCheckpointRecoveryError, MemoryCheckpointStore,
  parseCheckpointData, RedisCheckpointStore, REDIS_TTL_SECONDS, redisConfiguration,
} from "../src/checkpoint-store.ts";
import type { CheckpointStore, RedisCheckpointClient } from "../src/checkpoint-store.ts";
import { MissingSceneFilesError, parseSceneData, SCENE_LIMITS } from "../src/scene.ts";

function scene(text = "hello") {
  return parseSceneData({ elements: [{ type: "text", id: "text", x: 0, y: 0, text }] });
}
function conflict(revision: number | null) {
  return (error: unknown) => error instanceof CheckpointRevisionConflictError && error.currentRevision === revision;
}

async function ownedDirectory(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = path.resolve("tests", `.checkpoint-owned-${randomUUID()}`);
  await fs.mkdir(directory, { recursive: true });
  try { await action(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test("memory store revisions enforce create-only and compare-and-swap, preserving empty scenes", async () => {
  const store = new MemoryCheckpointStore();
  const first = await store.save("one", scene(), 0);
  assert.equal(first.revision, 1);
  await assert.rejects(store.save("one", scene("old writer")), conflict(1));
  await assert.rejects(store.save("one", scene("create"), 0), conflict(1));
  await assert.rejects(store.save("missing", scene(), 1), conflict(null));
  const empty = await store.save("one", parseSceneData({ elements: [] }), 1);
  assert.equal(empty.revision, 2);
  assert.deepEqual((await store.load("one"))?.elements, []);
  await assert.rejects(store.save("one", scene("stale"), 1), conflict(2));
  await assert.rejects(store.migrate("one", scene()), conflict(2));
});

test("memory instances and returned scenes are isolated and retention is intentional", async () => {
  const store = new MemoryCheckpointStore({ maxCheckpoints: 2 });
  const first = await store.save("one", scene());
  first.elements[0].text = "external mutation";
  assert.equal((await store.load("one"))?.elements[0].text, "hello");
  assert.equal(await new MemoryCheckpointStore().load("one"), null);
  await store.save("two", scene());
  await store.save("one", scene("new"), 1);
  await store.save("three", scene());
  assert.equal(await store.load("two"), null);
  assert.equal((await store.load("one"))?.revision, 2);
});

test("memory concurrent stale writers have exactly one successful CAS", async () => {
  const store = new MemoryCheckpointStore();
  await store.save("one", scene());
  const results = await Promise.allSettled([store.save("one", scene("A"), 1), store.save("one", scene("B"), 1)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected" && conflict(2)(result.reason)).length, 1);
});

test("invalid IDs, revisions, and scene data cannot modify a valid checkpoint", async () => {
  const store = new MemoryCheckpointStore();
  await store.save("one", scene());
  for (const id of ["", "../escape", "a/b", "a\\b", "a.json", "a".repeat(65)]) {
    await assert.rejects(store.save(id, scene()));
    await assert.rejects(store.load(id));
  }
  for (const revision of [-1, 0.5, NaN, Infinity]) await assert.rejects(store.save("one", scene(), revision));
  const invalid = scene();
  invalid.elements[0].x = Infinity;
  await assert.rejects(store.save("one", invalid, 1));
  assert.equal((await store.load("one"))?.revision, 1);
});

test("checkpoint envelope byte overhead cannot erase the previous memory revision", async () => {
  const store = new MemoryCheckpointStore();
  await store.save("one", scene());
  const oversized = scene();
  oversized.elements[0].customData = { padding: "" };
  const overhead = Buffer.byteLength(JSON.stringify(oversized), "utf8");
  oversized.elements[0].customData = { padding: "x".repeat(SCENE_LIMITS.maxBytes - overhead - 1) };
  assert.ok(Buffer.byteLength(JSON.stringify(oversized), "utf8") < SCENE_LIMITS.maxBytes);
  await assert.rejects(store.save("one", oversized, 1), /Checkpoint exceeds/);
  assert.equal((await store.load("one"))?.revision, 1);
  assert.equal((await store.load("one"))?.elements[0].text, "hello");
});

test("checkpoint parser distinguishes legacy recovery, corrupted data, and versioned missing image errors", () => {
  assert.equal(parseCheckpointData({ elements: [] }).revision, 0);
  assert.equal(parseCheckpointData({ ...scene(), revision: 3 }).revision, 3);
  for (const invalid of ["{", "null", "[]", "{}", { ...scene(), revision: 0 }, scene(), { elements: [], revision: 3 }]) {
    assert.throws(() => parseCheckpointData(invalid), CheckpointDataError);
  }
  const missingImage = { type: "image", id: "i", x: 0, y: 0, fileId: "lost" };
  const legacy = parseCheckpointData({ elements: [missingImage] });
  assert.deepEqual(legacy.elements, []);
  assert.equal(legacy.revision, 0);
  assert.deepEqual(legacy.recovery?.missingFileIds, ["lost"]);
  assert.deepEqual(legacy.recovery?.unavailableImages, [missingImage]);
  assert.throws(() => parseCheckpointData({ schemaVersion: 1, revision: 1, elements: [missingImage], files: {}, appState: {} }), MissingSceneFilesError);
  assert.throws(() => parseCheckpointData({ schemaVersion: 1, revision: 1, elements: [] }), CheckpointDataError);
});

test("file storage persists between instances, replaces atomically, and detects cross-instance CAS races", async () => {
  await ownedDirectory(async directory => {
    const a = new FileCheckpointStore(directory);
    const b = new FileCheckpointStore(directory);
    await a.save("shared", scene());
    assert.equal((await b.load("shared"))?.revision, 1);
    const results = await Promise.allSettled([a.save("shared", scene("A"), 1), b.save("shared", scene("B"), 1)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected" && conflict(2)(result.reason)).length, 1);
    const raw: unknown = JSON.parse(await fs.readFile(path.join(directory, "shared.json"), "utf8"));
    assert.equal(parseCheckpointData(raw).revision, 2);
    assert.deepEqual((await fs.readdir(directory)).sort(), ["shared.json"]);
    await assert.rejects(b.save("shared", scene()), conflict(2));
  });
});

test("file migration is lazy and explicitly revision-zero-only without rewriting historical data", async () => {
  await ownedDirectory(async directory => {
    const legacyDirectory = path.join(directory, "legacy");
    const currentDirectory = path.join(directory, "current");
    await fs.mkdir(legacyDirectory);
    const raw = JSON.stringify({ elements: [{ type: "cameraUpdate", x: 0, y: 0, width: 800, height: 600 }] });
    await fs.writeFile(path.join(legacyDirectory, "old.json"), raw);
    const store = new FileCheckpointStore({ directory: currentDirectory, legacyDirectory });
    const legacy = await store.load("old");
    assert.ok(legacy);
    assert.equal(legacy.revision, 0);
    assert.deepEqual(legacy.viewport, { x: 0, y: 0, width: 800, height: 600 });
    await assert.rejects(store.save("old", legacy, 0), conflict(0));
    await assert.rejects(store.save("old", legacy), conflict(0));
    const migrated = await store.migrate("old", legacy);
    assert.equal(migrated.revision, 1);
    assert.equal(await fs.readFile(path.join(legacyDirectory, "old.json"), "utf8"), raw);
    await assert.rejects(store.migrate("old", legacy), conflict(1));
    await assert.rejects(store.migrate("missing", scene()), conflict(null));
    assert.equal((await store.load("old"))?.revision, 1);
  });
});

test("legacy checkpoints with missing images remain recoverable without silently overwriting original data", async () => {
  await ownedDirectory(async directory => {
    const image = { type: "image", id: "missing-image", x: 10, y: 20, width: 30, height: 40, fileId: "lost" };
    const raw = JSON.stringify({ elements: [...scene("recoverable text").elements, image] });
    await fs.writeFile(path.join(directory, "legacy-images.json"), raw);
    const store = new FileCheckpointStore(directory);
    const loaded = await store.load("legacy-images");
    assert.ok(loaded);
    assert.equal(loaded.elements[0].text, "recoverable text");
    assert.deepEqual(loaded.recovery?.unavailableImages, [image]);
    await assert.rejects(store.migrate("legacy-images", loaded), LegacyCheckpointRecoveryError);
    assert.equal(await fs.readFile(path.join(directory, "legacy-images.json"), "utf8"), raw);
    assert.equal((await store.save("recovered-copy", loaded)).revision, 1);
    assert.equal((await store.load("legacy-images"))?.revision, 0);
    const restored = parseSceneData({
      ...loaded, elements: [...loaded.elements, ...loaded.recovery!.unavailableImages],
      files: { lost: { id: "lost", mimeType: "image/png", created: 1,
        dataURL: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7l8AAAAASUVORK5CYII=" } },
    });
    const migrated = await store.migrate("legacy-images", restored);
    assert.equal(migrated.revision, 1);
    assert.equal(migrated.elements[1].id, "missing-image");
    assert.equal(migrated.recovery, undefined);
  });
});

test("file CAS is serialized across separate Node processes, not just store instances", async () => {
  await ownedDirectory(async directory => {
    const store = new FileCheckpointStore(directory);
    await store.save("shared", scene());
    const sourceURL = pathToFileURL(path.resolve("src", "checkpoint-store.ts")).href;
    const registration = pathToFileURL(path.resolve("scripts", "register-ts.mjs")).href;
    const program = `
      const { FileCheckpointStore, CheckpointRevisionConflictError } = await import(process.argv[1]);
      const store = new FileCheckpointStore(process.argv[2]);
      try {
        const checkpoint = await store.save("shared", { schemaVersion: 1, elements: [], files: {}, appState: {} }, 1);
        process.stdout.write("saved:" + checkpoint.revision);
      } catch (error) {
        if (!(error instanceof CheckpointRevisionConflictError)) throw error;
        process.stdout.write("conflict:" + error.currentRevision);
      }
    `;
    const execute = promisify(execFile);
    const args = ["--experimental-strip-types", "--import", registration, "--input-type=module", "-e", program, sourceURL, directory];
    const results = await Promise.all([execute(process.execPath, args), execute(process.execPath, args)]);
    assert.deepEqual(results.map(result => result.stdout).sort(), ["conflict:2", "saved:2"]);
    assert.equal((await store.load("shared"))?.revision, 2);
  });
});

test("retention never deletes unrelated files or resurrects an evicted migrated legacy record", async () => {
  await ownedDirectory(async directory => {
    const legacyDirectory = path.join(directory, "legacy");
    const currentDirectory = path.join(directory, "current");
    await fs.mkdir(legacyDirectory);
    await fs.mkdir(currentDirectory);
    await fs.writeFile(path.join(legacyDirectory, "old.json"), JSON.stringify({ elements: [] }));
    await fs.writeFile(path.join(currentDirectory, "read.me.json"), "unrelated");
    await fs.writeFile(path.join(currentDirectory, "keep.txt"), "unrelated");
    const store = new FileCheckpointStore({ directory: currentDirectory, legacyDirectory, maxCheckpoints: 1 });
    await store.migrate("old", scene());
    await store.save("new", scene());
    assert.equal(await store.load("old"), null);
    assert.equal((await store.load("new"))?.revision, 1);
    assert.equal(await fs.readFile(path.join(currentDirectory, "read.me.json"), "utf8"), "unrelated");
    assert.equal(await fs.readFile(path.join(currentDirectory, "keep.txt"), "utf8"), "unrelated");
    assert.equal(await fs.readFile(path.join(legacyDirectory, "old.json"), "utf8"), '{"elements":[]}');
  });
});

test("file missing, corrupt, unreadable, oversized, and malformed UTF-8 cases are distinct", async () => {
  await ownedDirectory(async directory => {
    const store = new FileCheckpointStore(directory);
    assert.equal(await store.load("missing"), null);
    await fs.writeFile(path.join(directory, "corrupt.json"), "{");
    await assert.rejects(store.load("corrupt"), CheckpointDataError);
    await assert.rejects(store.save("corrupt", scene()), CheckpointDataError);
    assert.equal(await fs.readFile(path.join(directory, "corrupt.json"), "utf8"), "{");
    await fs.mkdir(path.join(directory, "not-file.json"));
    await assert.rejects(store.load("not-file"));
    await fs.writeFile(path.join(directory, "invalid-utf8.json"), Buffer.from([0xc3, 0x28]));
    await assert.rejects(store.load("invalid-utf8"), CheckpointDataError);
    await fs.writeFile(path.join(directory, "huge.json"), " ".repeat(SCENE_LIMITS.maxBytes + 1));
    await assert.rejects(store.load("huge"), CheckpointDataError);
    const fileInsteadOfDirectory = path.join(directory, "file-not-directory");
    await fs.writeFile(fileInsteadOfDirectory, "not a directory");
    await assert.rejects(new FileCheckpointStore(fileInsteadOfDirectory).load("one"));
  });
});

test("an abandoned or active file lock fails clearly instead of racing or silently replacing data", async () => {
  await ownedDirectory(async directory => {
    await fs.mkdir(path.join(directory, ".write-lock"));
    const store = new FileCheckpointStore({ directory, lockTimeoutMs: 0 });
    await assert.rejects(store.save("blocked", scene()), CheckpointLockError);
    assert.equal(await store.load("blocked"), null);
    assert.ok((await fs.stat(path.join(directory, ".write-lock"))).isDirectory());
  });
});

test("default local storage is persistent user data, and explicit directories do not read legacy user files", async () => {
  const configured = path.resolve("tests", "configured-data");
  assert.equal(defaultCheckpointDirectory({ EXCALIDRAW_DATA_DIR: configured }), configured);
  assert.ok(defaultCheckpointDirectory({}).includes("excalidraw-mcp"));
  assert.ok(!defaultCheckpointDirectory({}).endsWith("excalidraw-mcp-checkpoints"));
  await ownedDirectory(async directory => {
    assert.equal(await new FileCheckpointStore(directory).load("never-created-in-this-test"), null);
  });
});

/** Models a remote atomic EVAL boundary, not an in-process CAS in the production store. */
class RedisFixture implements RedisCheckpointClient {
  readonly values = new Map<string, string>();
  readonly calls: { script: string; keys: string[]; args: (string | number)[] }[] = [];
  beforeEval?: () => void;
  async get(key: string): Promise<unknown> { return this.values.get(key) ?? null; }
  async eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown> {
    this.beforeEval?.();
    this.calls.push({ script, keys, args });
    assert.equal(keys.length, 1);
    const [expectation, mode, next, ttl, snapshot] = args;
    assert.equal(ttl, REDIS_TTL_SECONDS);
    const raw = this.values.get(keys[0]);
    const current = raw === undefined ? null : parseCheckpointData(raw);
    const revision = current?.revision ?? -1;
    const matches = mode === "migrate" ? revision === 0 : expectation === 0 ? raw === undefined : revision === expectation;
    if (!matches || (raw ?? "") !== snapshot) return [0, revision];
    assert.equal(typeof next, "string");
    if (typeof next !== "string") throw new Error("Invalid fixture payload");
    this.values.set(keys[0], next);
    return [1, Math.max(revision, 0) + 1];
  }
}

test("all storage implementations round-trip actual image bytes, background settings, and viewport", async () => {
  await ownedDirectory(async directory => {
    const stores: CheckpointStore[] = [
      new MemoryCheckpointStore(), new FileCheckpointStore(directory), new RedisCheckpointStore({ client: new RedisFixture() }),
    ];
    const complete = parseSceneData({
      elements: [{ type: "image", id: "image", x: 1, y: 2, width: 16, height: 16, fileId: "file" }],
      files: { file: { id: "file", mimeType: "image/png", created: 1, version: 2, lastRetrieved: 3,
        dataURL: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7l8AAAAASUVORK5CYII=" } },
      appState: { viewBackgroundColor: "#223344", exportBackground: true, exportWithDarkMode: true, gridModeEnabled: true, gridSize: 20 },
      viewport: { x: 1, y: 2, width: 800, height: 600 },
    });
    for (const store of stores) {
      const first = await store.save("images", complete);
      assert.deepEqual(await store.load("images"), { ...complete, revision: 1 });
      first.files.file.dataURL = "mutated";
      assert.equal((await store.load("images"))?.files.file.dataURL, complete.files.file.dataURL);
      assert.deepEqual(await store.save("images", complete, 1), { ...complete, revision: 2 });
    }
  });
});

test("Redis storage delegates mutation to atomic Lua CAS across independent store instances", async () => {
  const client = new RedisFixture();
  const a = new RedisCheckpointStore({ client });
  const b = new RedisCheckpointStore({ client });
  await a.save("shared", scene());
  assert.equal((await b.load("shared"))?.revision, 1);
  const results = await Promise.allSettled([a.save("shared", scene("A"), 1), b.save("shared", scene("B"), 1)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected" && conflict(2)(result.reason)).length, 1);
  assert.ok(client.calls.every(call => call.script === CHECKPOINT_CAS_SCRIPT));
  assert.match(CHECKPOINT_CAS_SCRIPT, /redis\.call\("GET"/);
  assert.match(CHECKPOINT_CAS_SCRIPT, /redis\.call\("SET"/);
  assert.match(CHECKPOINT_CAS_SCRIPT, /current\.revision/);
});

test("Redis legacy migration compares the exact snapshot as well as revision zero", async () => {
  const client = new RedisFixture();
  client.values.set("cp:old", '{"elements":[]}');
  const store = new RedisCheckpointStore({ client });
  const legacy = await store.load("old");
  assert.ok(legacy);
  await assert.rejects(store.save("old", legacy, 0), conflict(0));
  client.beforeEval = () => client.values.set("cp:old", JSON.stringify({ elements: scene("other legacy writer").elements }));
  await assert.rejects(store.migrate("old", legacy), conflict(0));
  client.beforeEval = undefined;
  assert.equal((await store.migrate("old", legacy)).revision, 1);
  await assert.rejects(store.migrate("old", legacy), conflict(1));
});

test("Redis corruption and network failures propagate without success-shaped fallback", async () => {
  const client = new RedisFixture();
  client.values.set("cp:bad", "{");
  const store = new RedisCheckpointStore({ client });
  await assert.rejects(store.load("bad"), CheckpointDataError);
  await assert.rejects(store.save("bad", scene()), CheckpointDataError);
  const failure: RedisCheckpointClient = {
    async get() { throw new Error("simulated network failure"); },
    async eval() { throw new Error("must not be reached"); },
  };
  await assert.rejects(new RedisCheckpointStore({ client: failure }).load("one"), /simulated network failure/);
});

test("Vercel requires durable Redis unless ephemeral memory is explicitly selected", () => {
  assert.throws(() => createVercelStore({}), /Durable Redis storage requires both/);
  assert.ok(createVercelStore({ EXCALIDRAW_STORAGE: "memory" }) instanceof MemoryCheckpointStore);
  assert.ok(createVercelStore({ UPSTASH_REDIS_REST_URL: "https://redis.example", UPSTASH_REDIS_REST_TOKEN: "test-token" }) instanceof RedisCheckpointStore);
  assert.throws(() => createVercelStore({ EXCALIDRAW_STORAGE: "file" }), /redis or memory/);
  for (const env of [
    { KV_REST_API_URL: "https://redis.example" },
    { KV_REST_API_TOKEN: "not-a-real-secret" },
    { KV_REST_API_URL: "http://redis.example", KV_REST_API_TOKEN: "not-a-real-secret" },
    { KV_REST_API_URL: "https://user:password@redis.example", KV_REST_API_TOKEN: "not-a-real-secret" },
    { KV_REST_API_URL: "https://redis.example/path?token=private", KV_REST_API_TOKEN: "not-a-real-secret" },
    { KV_REST_API_URL: "https://redis.example", KV_REST_API_TOKEN: "token with whitespace" },
    { KV_REST_API_URL: "https://redis.example", UPSTASH_REDIS_REST_TOKEN: "not-a-real-secret" },
  ]) {
    assert.throws(() => redisConfiguration(env), (error: unknown) =>
      error instanceof Error && !error.message.includes("not-a-real-secret") && !error.message.includes("password@"));
  }
});
