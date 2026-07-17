import { supabase } from "./supabase";
import { warnOnce } from "./warn-once";

const CACHE_DOWN = "[cache] supabase unreachable — running uncached, full Firecrawl price";

function normalizeUrl(url: string): string {
  return url.replace(/[#?].*$/, "").replace(/\/$/, "");
}

export async function getCache(url: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("cache")
      .select("value")
      .eq("type", "scrape")
      .eq("key", normalizeUrl(url))
      .maybeSingle();

    if (error) {
      warnOnce("supabase", CACHE_DOWN);
      return null;
    }

    if (!data) return null;
    const entry = data.value as { content: string };
    return entry.content ?? null;
  } catch {
    warnOnce("supabase", CACHE_DOWN);
    return null;
  }
}

export async function setCache(url: string, content: string): Promise<void> {
  try {
    const { error } = await supabase.from("cache").upsert({
      type: "scrape",
      key: normalizeUrl(url),
      value: { content },
    });
    if (error) warnOnce("supabase", CACHE_DOWN);
  } catch {
    warnOnce("supabase", CACHE_DOWN);
  }
}
