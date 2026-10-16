import { getAdapter } from '@/lib/db/driver.js';

export async function POST(request) {
  const db = await getAdapter();
  if (!db.ha) return Response.json({ error: 'HA is not configured' }, { status: 409 });
  try {
    const text = await request.text();
    if (text.length > 16384) return Response.json({ error: 'Resolution too large' }, { status: 413 });
    const { entity, field, version, expected, action, name, expectedName } = JSON.parse(text);
    if (action === 'rename') db.ha.rename(entity, name, expectedName);
    else db.ha.resolve(entity, field, version, expected);
    return Response.json({ ok: true });
  } catch { return Response.json({ error: 'Conflict changed or invalid selection; reload before resolving' }, { status: 409 }); }
}
