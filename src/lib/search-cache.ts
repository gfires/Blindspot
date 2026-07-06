/**
 * search-cache.ts — persistent query→results cache that eliminates redundant Firecrawl searches.
 *
 * Keyed by the exact search query string. No TTL — entries persist until manually cleared.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

type CacheFile = Record<string, SearchResult[]>;

const CACHE_PATH = path.join(process.cwd(), "data", "search-cache.json");

let mem: CacheFile | null = null;

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

export async function getSearchCache(query: string): Promise<SearchResult[] | null> {
  const cache = await load();
  return cache[query] ?? null;
}

export async function setSearchCache(query: string, results: SearchResult[]): Promise<void> {
  const cache = await load();
  cache[query] = results;
  mem = cache;
  try {
    await fs.writeFile(CACHE_PATH, JSON.stringify(cache) + "\n", "utf8");
  } catch {}
}
