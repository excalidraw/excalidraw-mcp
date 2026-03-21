import crypto from "node:crypto";

export interface PngEntry {
  data: Buffer;
  filename: string;
  createdAt: number;
}

/** TTL for stored PNGs: 5 minutes. */
const TTL_MS = 5 * 60 * 1000;
/** Max stored PNGs before rejecting new uploads. */
const MAX_ENTRIES = 50;
/** Max PNG size: 4 MB (under Vercel's 4.5 MB payload limit). */
export const MAX_PNG_BYTES = 4 * 1024 * 1024;

export interface PngStore {
  save(data: Buffer, filename: string): Promise<string>;
  load(id: string): Promise<PngEntry | null>;
  delete(id: string): Promise<void>;
}

export class MemoryPngStore implements PngStore {
  private entries = new Map<string, PngEntry>();

  private sweep() {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (now - entry.createdAt > TTL_MS) {
        this.entries.delete(id);
      }
    }
  }

  async save(data: Buffer, filename: string): Promise<string> {
    this.sweep();
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 18);
    this.entries.set(id, { data, filename, createdAt: Date.now() });
    return id;
  }

  async load(id: string): Promise<PngEntry | null> {
    this.sweep();
    return this.entries.get(id) ?? null;
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }
}

/** Redis-backed PNG store for Vercel (base64 string stored with TTL). */
export class RedisPngStore implements PngStore {
  private redis: any = null;

  private async getRedis() {
    if (!this.redis) {
      const { Redis } = await import("@upstash/redis");
      const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
      const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
      if (!url || !token) throw new Error("Missing Redis env vars");
      this.redis = new Redis({ url, token });
    }
    return this.redis;
  }

  async save(data: Buffer, filename: string): Promise<string> {
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 18);
    const redis = await this.getRedis();
    await redis.set(`png:${id}`, JSON.stringify({
      data: data.toString("base64"),
      filename,
    }), { ex: 300 }); // 5 min TTL
    return id;
  }

  async load(id: string): Promise<PngEntry | null> {
    try {
      const redis = await this.getRedis();
      const raw = await redis.get(`png:${id}`);
      if (!raw) return null;
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return {
        data: Buffer.from(parsed.data, "base64"),
        filename: parsed.filename,
        createdAt: 0,
      };
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<void> {
    try {
      const redis = await this.getRedis();
      await redis.del(`png:${id}`);
    } catch {}
  }
}

export function createVercelPngStore(): PngStore {
  if (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) {
    return new RedisPngStore();
  }
  return new MemoryPngStore();
}
