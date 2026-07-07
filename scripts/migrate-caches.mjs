import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_ANON_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(url, key, { db: { schema: "blindspot" } });
const dataDir = join(process.cwd(), "data");

function readJson(file) {
  try {
    return JSON.parse(readFileSync(join(dataDir, file), "utf8"));
  } catch {
    return null;
  }
}

// --- Search cache ---
const searchCache = readJson("search-cache.json");
if (searchCache) {
  const rows = Object.entries(searchCache).map(([key, value]) => ({
    type: "search",
    key,
    value,
  }));
  const { error } = await supabase.from("cache").upsert(rows);
  if (error) console.error("Search cache error:", error.message);
  else console.log(`Migrated ${rows.length} search cache entries`);
} else {
  console.log("No search cache found, skipping");
}

// --- Scrape cache ---
const scrapeCache = readJson("scrape-cache.json");
if (scrapeCache) {
  const rows = Object.entries(scrapeCache).map(([key, value]) => ({
    type: "scrape",
    key,
    value,
  }));
  // Insert in batches of 20 since scrape entries can be large
  for (let i = 0; i < rows.length; i += 20) {
    const batch = rows.slice(i, i + 20);
    const { error } = await supabase.from("cache").upsert(batch);
    if (error) console.error(`Scrape cache batch ${i} error:`, error.message);
  }
  console.log(`Migrated ${rows.length} scrape cache entries`);
} else {
  console.log("No scrape cache found, skipping");
}

// --- Blocklist ---
const blocklist = readJson("blocklist.json");
if (blocklist?.domains) {
  const rows = Object.entries(blocklist.domains).map(([domain, meta]) => ({
    domain,
    reason: meta.reason,
    added_at: meta.addedAt === "seed" ? "1970-01-01T00:00:00Z" : meta.addedAt,
  }));
  const { error } = await supabase.from("blocklist").upsert(rows);
  if (error) console.error("Blocklist error:", error.message);
  else console.log(`Migrated ${rows.length} blocklist entries`);
} else {
  console.log("No blocklist found, skipping");
}

console.log("Done!");
