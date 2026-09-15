import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { Redis } from "@upstash/redis";
import {
  parseSceneData, recoverLegacySceneData, SCENE_LIMITS, SceneValidationError, MissingSceneFilesError,
  utf8ByteLength, validateCheckpointId,
} from "./scene.js";
import type { Checkpoint, SceneData } from "./scene.js";

export type { Checkpoint, SceneData } from "./scene.js";
export { validateCheckpointId } from "./scene.js";
export const MAX_CHECKPOINT_BYTES = SCENE_LIMITS.maxBytes;
export const MAX_FILE_CHECKPOINTS = 100;
export const REDIS_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface CheckpointStore {
  /** Missing/zero expectations create only; positive expectations compare and swap. */
  save(id: string, data: SceneData, expectedRevision?: number): Promise<Checkpoint>;
  /** Explicitly upgrade an existing legacy revision-zero record; never creates or replaces revision one. */
  migrate(id: string, data: SceneData): Promise<Checkpoint>;
  load(id: string): Promise<Checkpoint | null>;
}

export class CheckpointRevisionConflictError extends Error {
  readonly checkpointId: string;
  readonly expectedRevision: number;
  readonly currentRevision: number | null;
  constructor(id: string, expectedRevision: number, currentRevision: number | null) {
    const current = currentRevision === null ? "missing" : `${currentRevision}`;
    super(`Checkpoint "${id}" revision conflict: expected ${expectedRevision}, current ${current}. Reload before saving; revision 0 updates require explicit legacy migration.`);
    this.name = "CheckpointRevisionConflictError";
    this.checkpointId = id;
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
  }
}

export class CheckpointDataError extends Error {
  readonly checkpointId: string;
  constructor(id: string, cause: unknown) {
    super(`Checkpoint "${id}" contains invalid or corrupt data; it was not overwritten.`, { cause });
    this.name = "CheckpointDataError";
    this.checkpointId = id;
  }
}

export class LegacyCheckpointRecoveryError extends Error {
  readonly checkpointId: string;
  readonly missingFileIds: string[];
  constructor(id: string, missingFileIds: string[]) {
    super(`Legacy checkpoint "${id}" has unavailable images (${missingFileIds.join(", ")}). Restore those image elements with their files, or save the recovered scene as a new checkpoint. The original checkpoint was not overwritten.`);
    this.name = "LegacyCheckpointRecoveryError";
    this.checkpointId = id;
    this.missingFileIds = [...missingFileIds];
  }
}

export class CheckpointLockError extends Error {
  constructor(directory: string) {
    super(`Checkpoint storage is busy or has an abandoned .write-lock in "${directory}". Retry, or remove that lock only after confirming no writer is running.`);
    this.name = "CheckpointLockError";
  }
}

export class CheckpointRetentionError extends Error {
  readonly savedCheckpoint: Checkpoint;
  constructor(checkpoint: Checkpoint, cause: unknown) {
    super(`Checkpoint revision ${checkpoint.revision} was saved, but retention cleanup failed. Reload before retrying.`, { cause });
    this.name = "CheckpointRetentionError";
    this.savedCheckpoint = checkpoint;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function expected(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new SceneValidationError("invalid_revision", "Expected a nonnegative safe integer revision.", "expectedRevision");
  }
  return value;
}

function serialized(data: Checkpoint): string {
  const raw = JSON.stringify(data);
  if (utf8ByteLength(raw) > MAX_CHECKPOINT_BYTES) {
    throw new SceneValidationError("checkpoint_size_limit", `Checkpoint exceeds ${MAX_CHECKPOINT_BYTES} UTF-8 bytes.`, "checkpoint");
  }
  return raw;
}

export function parseCheckpointData(value: unknown, id = "unknown"): Checkpoint {
  try {
    let decoded: unknown = value;
    if (typeof value === "string") {
      if (utf8ByteLength(value) > MAX_CHECKPOINT_BYTES) {
        throw new SceneValidationError("checkpoint_size_limit", "Stored checkpoint exceeds its byte limit.", "checkpoint");
      }
      decoded = JSON.parse(value);
    }
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw new SceneValidationError("invalid_checkpoint", "Expected a checkpoint object.", "checkpoint");
    }
    const revision = "revision" in decoded ? decoded.revision : 0;
    const versioned = "schemaVersion" in decoded;
    if (!Number.isSafeInteger(revision) || typeof revision !== "number" || revision < 0 ||
        (versioned && revision === 0) || (!versioned && revision !== 0)) {
      throw new SceneValidationError("invalid_revision", "Versioned checkpoints require a positive integer revision; legacy checkpoints use revision 0.", "checkpoint.revision");
    }
    const recovered = versioned ? { scene: parseSceneData(decoded) } : recoverLegacySceneData(decoded);
    const result: Checkpoint = {
      ...recovered.scene, revision,
      ...(recovered.recovery ? { recovery: recovered.recovery } : {}),
    };
    serialized(result);
    return result;
  } catch (error) {
    if (error instanceof MissingSceneFilesError) throw error;
    if (error instanceof SyntaxError || error instanceof SceneValidationError) throw new CheckpointDataError(id, error);
    throw error;
  }
}

function nextCheckpoint(
  id: string, scene: SceneData, current: Checkpoint | null, expectation: number, migrate: boolean,
): Checkpoint {
  let matches: boolean;
  if (migrate) {
    matches = current?.revision === 0;
  } else if (expectation === 0) {
    matches = current === null;
  } else {
    matches = current?.revision === expectation;
  }
  if (!matches) throw new CheckpointRevisionConflictError(id, expectation, current?.revision ?? null);
  if (migrate && current?.recovery?.unavailableImages.some(image =>
    !scene.elements.some(entry => entry.id === image.id && entry.type === "image"))) {
    throw new LegacyCheckpointRecoveryError(id, current.recovery.missingFileIds);
  }
  const revision = (current?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) throw new SceneValidationError("invalid_revision", "Checkpoint revision limit reached.", "revision");
  return { ...scene, revision };
}

function retentionLimit(value = MAX_FILE_CHECKPOINTS): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("maxCheckpoints must be a positive safe integer.");
  return value;
}

export function defaultCheckpointDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.EXCALIDRAW_DATA_DIR) return path.resolve(env.EXCALIDRAW_DATA_DIR);
  let root: string;
  switch (process.platform) {
    case "win32":
      root = env.LOCALAPPDATA || env.APPDATA || path.join(os.homedir(), "AppData", "Local");
      break;
    case "darwin":
      root = path.join(os.homedir(), "Library", "Application Support");
      break;
    default:
      root = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  }
  return path.join(root, "excalidraw-mcp", "checkpoints");
}

export interface FileCheckpointStoreOptions {
  directory?: string;
  /** Read-only fallback. Disabled by default when a custom directory is supplied. */
  legacyDirectory?: string | false;
  maxCheckpoints?: number;
  lockTimeoutMs?: number;
}

export class FileCheckpointStore implements CheckpointStore {
  readonly directory: string;
  private readonly legacyDirectory?: string;
  private readonly maxCheckpoints: number;
  private readonly lockTimeoutMs: number;

  constructor(options: FileCheckpointStoreOptions | string = {}) {
    const config = typeof options === "string" ? { directory: options } : options;
    this.directory = path.resolve(config.directory ?? defaultCheckpointDirectory());
    const legacy = config.legacyDirectory ?? (config.directory === undefined
      ? path.join(os.tmpdir(), "excalidraw-mcp-checkpoints") : false);
    this.legacyDirectory = legacy === false ? undefined : path.resolve(legacy);
    this.maxCheckpoints = retentionLimit(config.maxCheckpoints);
    this.lockTimeoutMs = config.lockTimeoutMs ?? 5_000;
    if (!Number.isFinite(this.lockTimeoutMs) || this.lockTimeoutMs < 0) throw new Error("lockTimeoutMs must be nonnegative and finite.");
  }

  private async read(directory: string, id: string): Promise<Checkpoint | null> {
    const filePath = path.join(directory, `${id}.json`);
    let handle;
    try { handle = await fs.open(filePath, "r"); }
    catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      // Windows can return ENOENT, rather than ENOTDIR, for a non-directory ancestor.
      let ancestor = directory;
      for (;;) {
        try {
          if (!(await fs.stat(ancestor)).isDirectory()) {
            throw new Error(`Checkpoint storage ancestor "${ancestor}" is not a directory.`);
          }
          break;
        } catch (directoryError) {
          if (!hasCode(directoryError, "ENOENT")) throw directoryError;
          const parent = path.dirname(ancestor);
          if (parent === ancestor) break;
          ancestor = parent;
        }
      }
      return null;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new CheckpointDataError(id, new Error("Checkpoint path is not a regular file."));
      if (stat.size > MAX_CHECKPOINT_BYTES) throw new CheckpointDataError(id, new Error("Stored checkpoint exceeds its byte limit."));
      const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_CHECKPOINT_BYTES + 1));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > stat.size || offset > MAX_CHECKPOINT_BYTES) throw new CheckpointDataError(id, new Error("Checkpoint changed during reading or exceeds its byte limit."));
      let raw: string;
      try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset)); }
      catch (error) {
        if (error instanceof TypeError) throw new CheckpointDataError(id, new Error("Checkpoint is not valid UTF-8.", { cause: error }));
        throw error;
      }
      return parseCheckpointData(raw, id);
    } finally {
      await handle.close();
    }
  }

  async load(id: string): Promise<Checkpoint | null> {
    validateCheckpointId(id);
    const current = await this.read(this.directory, id);
    if (current || !this.legacyDirectory || this.legacyDirectory === this.directory) return current;
    try {
      await fs.stat(path.join(this.directory, `.retired-${id}`));
      return null;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    return this.read(this.legacyDirectory, id);
  }

  async save(id: string, data: SceneData, expectedRevision?: number): Promise<Checkpoint> {
    return this.write(id, data, expected(expectedRevision), false);
  }

  async migrate(id: string, data: SceneData): Promise<Checkpoint> {
    return this.write(id, data, 0, true);
  }

  private async lock<T>(action: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = path.join(this.directory, ".write-lock");
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try { await fs.mkdir(lockPath); break; }
      catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        if (Date.now() >= deadline) throw new CheckpointLockError(this.directory);
        await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
      }
    }
    try { return await action(); }
    finally { await fs.rmdir(lockPath); }
  }

  private async write(id: string, data: SceneData, expectation: number, migrate: boolean): Promise<Checkpoint> {
    validateCheckpointId(id);
    const scene = parseSceneData(data);
    return this.lock(async () => {
      const checkpoint = nextCheckpoint(id, scene, await this.load(id), expectation, migrate);
      const raw = serialized(checkpoint);
      const draftPath = path.join(this.directory, `.write-${id}-${randomUUID()}`);
      const handle = await fs.open(draftPath, "wx", 0o600);
      let renamed = false;
      try {
        try {
          await handle.writeFile(raw, "utf8");
          await handle.sync();
        } finally { await handle.close(); }
        await fs.rename(draftPath, path.join(this.directory, `${id}.json`));
        renamed = true;
      } finally {
        if (!renamed) await fs.unlink(draftPath);
      }
      try { await this.prune(id); }
      catch (error) { throw new CheckpointRetentionError(checkpoint, error); }
      return checkpoint;
    });
  }

  private async prune(savedId: string): Promise<void> {
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    const files = entries.filter(entry => entry.isFile() && /^[a-zA-Z0-9_-]{1,64}\.json$/.test(entry.name));
    if (files.length <= this.maxCheckpoints) return;
    const ordered = await Promise.all(files.filter(entry => entry.name !== `${savedId}.json`).map(async entry => ({
      name: entry.name, mtime: (await fs.stat(path.join(this.directory, entry.name))).mtimeMs,
    })));
    ordered.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
    for (const entry of ordered.slice(0, files.length - this.maxCheckpoints)) {
      // Never let an evicted migrated record reappear from its old read-only location.
      if (this.legacyDirectory && this.legacyDirectory !== this.directory) {
        let hasLegacyFile = false;
        try {
          await fs.stat(path.join(this.legacyDirectory, entry.name));
          hasLegacyFile = true;
        } catch (error) {
          if (!hasCode(error, "ENOENT")) throw error;
        }
        if (hasLegacyFile) await fs.writeFile(path.join(this.directory, `.retired-${entry.name.slice(0, -5)}`), "", { mode: 0o600 });
      }
      await fs.unlink(path.join(this.directory, entry.name));
    }
  }
}

/** Explicitly ephemeral and instance-scoped; this is not suitable for durable production storage. */
export class MemoryCheckpointStore implements CheckpointStore {
  private readonly records = new Map<string, string>();
  private readonly maxCheckpoints: number;
  constructor(options: { maxCheckpoints?: number } = {}) {
    this.maxCheckpoints = retentionLimit(options.maxCheckpoints);
  }
  async save(id: string, data: SceneData, expectedRevision?: number): Promise<Checkpoint> {
    return this.write(id, data, expected(expectedRevision), false);
  }
  async migrate(id: string, data: SceneData): Promise<Checkpoint> {
    return this.write(id, data, 0, true);
  }
  private write(id: string, data: SceneData, expectation: number, migrate: boolean): Checkpoint {
    validateCheckpointId(id);
    const scene = parseSceneData(data);
    const raw = this.records.get(id);
    const current = raw === undefined ? null : parseCheckpointData(raw, id);
    const checkpoint = nextCheckpoint(id, scene, current, expectation, migrate);
    const nextRaw = serialized(checkpoint);
    this.records.delete(id);
    this.records.set(id, nextRaw);
    while (this.records.size > this.maxCheckpoints) {
      const oldest = this.records.keys().next().value;
      if (oldest !== undefined) this.records.delete(oldest);
    }
    return checkpoint;
  }
  async load(id: string): Promise<Checkpoint | null> {
    validateCheckpointId(id);
    const raw = this.records.get(id);
    return raw === undefined ? null : parseCheckpointData(raw, id);
  }
}

export type StorageEnvironment = Readonly<Record<string, string | undefined>>;
export interface RedisCheckpointClient {
  get(key: string): Promise<unknown>;
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
}
export interface RedisCheckpointStoreOptions {
  env?: StorageEnvironment;
  client?: RedisCheckpointClient;
}

export function redisConfiguration(env: StorageEnvironment): { url: string; token: string } {
  const kv = env.KV_REST_API_URL !== undefined || env.KV_REST_API_TOKEN !== undefined;
  const url = kv ? env.KV_REST_API_URL : env.UPSTASH_REDIS_REST_URL;
  const token = kv ? env.KV_REST_API_TOKEN : env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Durable Redis storage requires both KV_REST_API_URL/KV_REST_API_TOKEN or both UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN. Use EXCALIDRAW_STORAGE=memory only for an explicitly ephemeral demo.");
  let parsed: URL;
  try { parsed = new URL(url); }
  catch (error) {
    if (error instanceof TypeError) throw new Error("Redis storage URL must be a valid HTTPS origin.");
    throw error;
  }
  if (url.trim() !== url || parsed.protocol !== "https:" || !parsed.hostname || parsed.username ||
      parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error("Redis storage URL must be an HTTPS origin without credentials, a path, a query, or a fragment.");
  }
  if (/\s/u.test(token)) throw new Error("Redis storage token must be nonempty and contain no whitespace.");
  return { url, token };
}

export const CHECKPOINT_CAS_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
local revision = -1
if raw then
  local ok, current = pcall(cjson.decode, raw)
  if not ok or type(current) ~= "table" or type(current.elements) ~= "table" then return {-1, -1} end
  if current.schemaVersion == nil then
    if current.revision ~= nil and current.revision ~= 0 then return {-1, -1} end
    revision = 0
  else
    if current.schemaVersion ~= 1 or type(current.revision) ~= "number" or current.revision < 1 or current.revision % 1 ~= 0 then return {-1, -1} end
    revision = current.revision
  end
end
local expected = tonumber(ARGV[1])
local migrating = ARGV[2] == "migrate"
if (migrating and revision ~= 0) or
   (not migrating and expected == 0 and raw) or
   (not migrating and expected > 0 and revision ~= expected) then return {0, revision} end
if (raw or "") ~= ARGV[5] then return {0, revision} end
redis.call("SET", KEYS[1], ARGV[3], "EX", ARGV[4])
return {1, math.max(revision, 0) + 1}
`;

export class RedisCheckpointStore implements CheckpointStore {
  private readonly config?: { url: string; token: string };
  private readonly client?: RedisCheckpointClient;
  private redis?: Promise<Redis>;
  constructor(options: RedisCheckpointStoreOptions = {}) {
    this.client = options.client;
    if (!this.client) this.config = redisConfiguration(options.env ?? process.env);
  }
  private async getRedis(): Promise<RedisCheckpointClient> {
    if (this.client) return this.client;
    const config = this.config;
    if (!config) throw new Error("Redis storage is not configured.");
    this.redis ??= import("@upstash/redis").then(({ Redis }) =>
      new Redis({ ...config, automaticDeserialization: false }));
    return this.redis;
  }
  private async readRaw(id: string): Promise<string | null> {
    const raw = await (await this.getRedis()).get(`cp:${id}`);
    if (raw === null) return null;
    if (typeof raw !== "string") throw new CheckpointDataError(id, new Error("Expected a raw JSON string from Redis."));
    return raw;
  }
  async save(id: string, data: SceneData, expectedRevision?: number): Promise<Checkpoint> {
    return this.write(id, data, expected(expectedRevision), false);
  }
  async migrate(id: string, data: SceneData): Promise<Checkpoint> {
    return this.write(id, data, 0, true);
  }
  private async write(id: string, data: SceneData, expectation: number, migrate: boolean): Promise<Checkpoint> {
    validateCheckpointId(id);
    const scene = parseSceneData(data);
    const raw = await this.readRaw(id);
    const checkpoint = nextCheckpoint(id, scene, raw === null ? null : parseCheckpointData(raw, id), expectation, migrate);
    const result = await (await this.getRedis()).eval(CHECKPOINT_CAS_SCRIPT, [`cp:${id}`], [
      expectation, migrate ? "migrate" : "save", serialized(checkpoint), REDIS_TTL_SECONDS, raw ?? "",
    ]);
    if (!Array.isArray(result) || result.length !== 2 || typeof result[0] !== "number" || typeof result[1] !== "number") {
      throw new Error("Redis returned an invalid checkpoint CAS result; reload before retrying.");
    }
    if (result[0] === 0) throw new CheckpointRevisionConflictError(id, expectation, result[1] === -1 ? null : result[1]);
    if (result[0] === -1) throw new CheckpointDataError(id, new Error("Stored checkpoint changed to invalid data."));
    if (result[0] !== 1 || result[1] !== checkpoint.revision) throw new Error("Redis returned an unexpected checkpoint revision; reload before retrying.");
    return checkpoint;
  }
  async load(id: string): Promise<Checkpoint | null> {
    validateCheckpointId(id);
    const raw = await this.readRaw(id);
    return raw === null ? null : parseCheckpointData(raw, id);
  }
}

export function createVercelStore(env: StorageEnvironment = process.env): CheckpointStore {
  if (env.EXCALIDRAW_STORAGE === "memory") return new MemoryCheckpointStore();
  if (env.EXCALIDRAW_STORAGE !== undefined && env.EXCALIDRAW_STORAGE !== "redis") {
    throw new Error("EXCALIDRAW_STORAGE must be redis or memory on Vercel.");
  }
  return new RedisCheckpointStore({ env });
}
