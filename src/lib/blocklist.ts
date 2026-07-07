import { supabase } from "./supabase";
import { domainOf } from "./format";

const HARD_BLOCK_STATUSES = new Set([401, 403, 429, 451]);

let cache: Set<string> | null = null;

export function blocklistKey(hostnameOrUrl: string): string {
  const host = hostnameOrUrl.includes("/") ? domainOf(hostnameOrUrl) : hostnameOrUrl;
  return host.toLowerCase().replace(/^www\./, "");
}

export async function loadBlocklist(): Promise<Set<string>> {
  if (cache) return cache;

  const { data } = await supabase.from("blocklist").select("domain");
  cache = new Set((data ?? []).map((row: { domain: string }) => blocklistKey(row.domain)));
  return cache;
}

export async function isBlocked(hostnameOrUrl: string): Promise<boolean> {
  const set = await loadBlocklist();
  return set.has(blocklistKey(hostnameOrUrl));
}

export function isHardBlock(status: number | undefined, message?: string): boolean {
  if (status && HARD_BLOCK_STATUSES.has(status)) return true;
  const m = message?.match(/status code:\s*(\d{3})/i);
  if (m && HARD_BLOCK_STATUSES.has(Number(m[1]))) return true;
  return false;
}

export async function recordBlock(hostnameOrUrl: string, reason: string, nowIso: string): Promise<void> {
  const key = blocklistKey(hostnameOrUrl);
  if (!key) return;

  if (cache) cache.add(key);

  await supabase.from("blocklist").upsert({
    domain: key,
    reason,
    added_at: nowIso,
  });
}

export function _resetBlocklistCache(): void {
  cache = null;
}
