import { NextResponse } from "next/server";
import { getUsageStats } from "@/lib/usageDb";
import { VALID_USAGE_STATS_PERIODS } from "@/lib/usagePeriods.js";
import { hasValidCliToken, isAuthenticated } from "@/dashboardGuard";

export const dynamic = "force-dynamic";

async function requireAuth(request) {
  if (await hasValidCliToken(request) || await isAuthenticated(request)) return true;
  return false;
}

export async function GET(request) {
  if (!(await requireAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";

    if (!VALID_USAGE_STATS_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    const stats = await getUsageStats(period);
    return NextResponse.json(stats);
  } catch (error) {
    console.error("[API] Failed to get usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}
