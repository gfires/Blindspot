/**
 * blocklist.ts — the running list of scrape-hostile domains.
 *
 * FOR FUTURE AGENTS: This is the app's ONLY persistent state (everything else is one-shot).
 * It exists to make the scanner learn from anti-scraping failures instead of repeating them:
 *
 *   • BEFORE scraping — sources on the blocklist are skipped proactively (never even attempted),
 *     surfaced in the UI as "skipped — known blocker" so the user sees the choice.
 *   • AFTER a failure — if a scrape fails with a HARD-BLOCK status (401/403/429/451), the domain
 *     is appended here so future scans skip it. Transient failures (timeouts, 404, 5xx, network)
 *     do NOT blocklist — those are one-offs, not policies.
 *
 * Storage: data/blocklist.json (see that file's _comment). Reads are cached per process; writes
 * are best-effort and defensive — a disk error must never break a scan, so every fs call is
 * wrapped and failures are swallowed (the domain just won't be remembered next time).
 *
 * Domains are normalized to bare, lowercase hostnames WITHOUT a leading "www." so that
 * "reddit.com" and "www.reddit.com" are treated as the same entry.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { domainOf } from "./format";

/** On-disk shape. `_comment` is documentation for humans opening the file; ignored by code. */
interface BlocklistFile {
  _comment?: string;
  domains: Record<string, { reason: string; addedAt: string }>;
}

const BLOCKLIST_PATH = path.join(process.cwd(), "data", "blocklist.json");

/** HTTP statuses that mean "this site blocks scrapers" — the only ones that trigger a record. */
const HARD_BLOCK_STATUSES = new Set([401, 403, 429, 451]);

/** Process-level cache so we read the file once per server process, not per source. */
let cache: Set<string> | null = null;

/** Normalize any hostname or URL to a bare, lowercase, www-less key. */
export function blocklistKey(hostnameOrUrl: string): string {
  const host = hostnameOrUrl.includes("/") ? domainOf(hostnameOrUrl) : hostnameOrUrl;
  return host.toLowerCase().replace(/^www\./, "");
}

/** Read the raw file, tolerating a missing or malformed file (returns an empty blocklist). */
async function readFile(): Promise<BlocklistFile> {
  try {
    const raw = await fs.readFile(BLOCKLIST_PATH, "utf8");
    const parsed = JSON.parse(raw) as BlocklistFile;
    return { domains: parsed.domains ?? {}, _comment: parsed._comment };
  } catch {
    return { domains: {} };
  }
}

/** Load (and cache) the set of blocked domain keys. */
export async function loadBlocklist(): Promise<Set<string>> {
  if (cache) return cache;
  const file = await readFile();
  cache = new Set(Object.keys(file.domains).map(blocklistKey));
  return cache;
}

/** Is this hostname/URL currently blocklisted? Async because it may load the file on first call. */
export async function isBlocked(hostnameOrUrl: string): Promise<boolean> {
  const set = await loadBlocklist();
  return set.has(blocklistKey(hostnameOrUrl));
}

/**
 * Decide whether a scrape error should blocklist the domain. Pass the error's HTTP status
 * (Firecrawl surfaces `statusCode`, and we also sniff the message for a "Status code: NNN"
 * fragment as a fallback). Returns true ONLY for hard-block statuses.
 */
export function isHardBlock(status: number | undefined, message?: string): boolean {
  if (status && HARD_BLOCK_STATUSES.has(status)) return true;
  const m = message?.match(/status code:\s*(\d{3})/i);
  if (m && HARD_BLOCK_STATUSES.has(Number(m[1]))) return true;
  return false;
}

/**
 * Record a domain as a blocker (idempotent). Best-effort: re-reads the file, merges, and writes
 * it back. Never throws — a failed write just means we don't remember this domain. Updates the
 * in-process cache regardless so the rest of THIS run also skips it.
 *
 * `nowIso` is injected (not read from the clock here) so the caller controls the timestamp,
 * keeping this function easy to test.
 */
export async function recordBlock(hostnameOrUrl: string, reason: string, nowIso: string): Promise<void> {
  const key = blocklistKey(hostnameOrUrl);
  if (!key) return;

  // Update the live cache immediately so concurrent/later sources in this run skip it too.
  if (cache) cache.add(key);

  try {
    const file = await readFile();
    if (file.domains[key]) return; // already known — nothing to write
    file.domains[key] = { reason, addedAt: nowIso };
    // Write sorted for a stable, reviewable diff.
    const sorted: BlocklistFile["domains"] = {};
    for (const k of Object.keys(file.domains).sort()) sorted[k] = file.domains[k];
    const out: BlocklistFile = { _comment: file._comment, domains: sorted };
    await fs.writeFile(BLOCKLIST_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
  } catch {
    // Swallow: persistence is a nicety, not a requirement. The cache update above still helps.
  }
}

/** Test/maintenance helper: drop the in-process cache so the next read hits disk. */
export function _resetBlocklistCache(): void {
  cache = null;
}
