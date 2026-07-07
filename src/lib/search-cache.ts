import { supabase } from "./supabase";

interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

export async function getSearchCache(query: string): Promise<SearchResult[] | null> {
  const { data } = await supabase
    .from("cache")
    .select("value")
    .eq("type", "search")
    .eq("key", query)
    .maybeSingle();

  return data ? (data.value as SearchResult[]) : null;
}

export async function setSearchCache(query: string, results: SearchResult[]): Promise<void> {
  await supabase.from("cache").upsert({
    type: "search",
    key: query,
    value: results,
  });
}
