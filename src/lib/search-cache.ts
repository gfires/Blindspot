import { supabase } from "./supabase";
import { warnOnce } from "./warn-once";

const CACHE_DOWN = "[cache] supabase unreachable — running uncached, full Firecrawl price";

interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

export async function getSearchCache(query: string): Promise<SearchResult[] | null> {
  try {
    const { data, error } = await supabase
      .from("cache")
      .select("value")
      .eq("type", "search")
      .eq("key", query)
      .maybeSingle();

    if (error) {
      warnOnce("supabase", CACHE_DOWN);
      return null;
    }

    return data ? (data.value as SearchResult[]) : null;
  } catch {
    warnOnce("supabase", CACHE_DOWN);
    return null;
  }
}

export async function setSearchCache(query: string, results: SearchResult[]): Promise<void> {
  try {
    const { error } = await supabase.from("cache").upsert({
      type: "search",
      key: query,
      value: results,
    });
    if (error) warnOnce("supabase", CACHE_DOWN);
  } catch {
    warnOnce("supabase", CACHE_DOWN);
  }
}
