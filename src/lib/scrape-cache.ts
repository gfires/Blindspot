import { supabase } from "./supabase";

function normalizeUrl(url: string): string {
  return url.replace(/[#?].*$/, "").replace(/\/$/, "");
}

export async function getCache(url: string): Promise<string | null> {
  const { data } = await supabase
    .from("cache")
    .select("value")
    .eq("type", "scrape")
    .eq("key", normalizeUrl(url))
    .maybeSingle();

  if (!data) return null;
  const entry = data.value as { content: string };
  return entry.content ?? null;
}

export async function setCache(url: string, content: string): Promise<void> {
  await supabase.from("cache").upsert({
    type: "scrape",
    key: normalizeUrl(url),
    value: { content },
  });
}
