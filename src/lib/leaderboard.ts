import { supabase } from "./supabase";
import type { Scores } from "./schema";

export interface LeaderboardEntry {
  industry: string;
  score: number;
  sub_scores: Scores;
  scanned_at: string;
}

export async function recordScan(industry: string, score: number, subScores: Scores): Promise<void> {
  const { data: existing } = await supabase
    .from("leaderboard")
    .select("score")
    .eq("industry", industry)
    .maybeSingle();

  if (existing && existing.score >= score) return;

  await supabase.from("leaderboard").upsert({
    industry,
    score,
    sub_scores: subScores,
    scanned_at: new Date().toISOString(),
  });
}

export async function getTopScans(limit = 10): Promise<LeaderboardEntry[]> {
  const { data, error } = await supabase
    .from("leaderboard")
    .select("industry, score, sub_scores, scanned_at")
    .order("score", { ascending: false })
    .limit(limit);

  if (error) return [];
  return data as LeaderboardEntry[];
}
