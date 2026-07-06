/**
 * scrape-cache.ts — persistent URL→content cache that eliminates redundant Firecrawl scrapes.
 *
 * Same pattern as blocklist.ts: a single JSON file in data/, no database, survives restarts.
 * No TTL — entries persist until manually cleared. The cache key is the normalized URL
 * (fragment/query/trailing-slash stripped).
 */
import { promises as fs } from "node:fs";
import path from "node:path";

interface CacheEntry {
  content: string;
}

type CacheFile = Record<string, CacheEntry>;

const CACHE_PATH = path.join(process.cwd(), "data", "scrape-cache.json");

let mem: CacheFile | null = null;

function normalizeUrl(url: string): string {
  return url.replace(/[#?].*$/, "").replace(/\/$/, "");
}

async function readFile(): Promise<CacheFile> {
  try {
    const raw = await fs.readFile(CACHE_PATH, "utf8");
    return JSON.parse(raw) as CacheFile;
  } catch {
    return {};
  }
}

async function load(): Promise<CacheFile> {
  if (mem) return mem;
  mem = await readFile();
  return mem;
}

export async function getCache(url: string): Promise<string | null> {
  const cache = await load();
  const entry = cache[normalizeUrl(url)];
  return entry?.content ?? null;
}

export async function setCache(url: string, content: string): Promise<void> {
  const cache = await load();
  cache[normalizeUrl(url)] = { content };
  mem = cache;
  try {
    await fs.writeFile(CACHE_PATH, JSON.stringify(cache) + "\n", "utf8");
  } catch {
    // Best-effort — a failed write just means we re-scrape next time.
  }
}
