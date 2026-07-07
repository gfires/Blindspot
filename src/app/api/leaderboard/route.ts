import { getTopScans } from "@/lib/leaderboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const entries = await getTopScans(10);
  return Response.json(entries);
}
