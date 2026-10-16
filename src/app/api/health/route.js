import { NextResponse } from "next/server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function GET() {
  if (process.env.NINEROUTER_HA_CONFIG) {
    try {
      const { getAdapter } = await import('@/lib/db/driver.js');
      (await getAdapter()).get('SELECT 1');
    } catch {
      return NextResponse.json({ ok: false }, { status: 503, headers: CORS_HEADERS });
    }
  }
  return NextResponse.json({ ok: true }, { headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
