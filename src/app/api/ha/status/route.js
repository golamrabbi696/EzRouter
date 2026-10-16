import { getAdapter } from '@/lib/db/driver.js';

export async function GET() {
  const db = await getAdapter();
  return Response.json(db.ha ? { enabled: true, ...db.ha.runtime.status() } : { enabled: false }, { headers: { 'cache-control': 'no-store' } });
}

export async function POST() {
  const db = await getAdapter();
  if (!db.ha) return Response.json({ error: 'HA is not configured' }, { status: 409 });
  try { await db.ha.runtime.syncOnce(); return Response.json({ ok: true }); }
  catch { return Response.json({ error: 'Peer unavailable; local service remains active' }, { status: 503 }); }
}
