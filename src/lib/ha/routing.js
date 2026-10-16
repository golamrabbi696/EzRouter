import { getAdapter } from '@/lib/db/driver.js';
import { getProviderConnections } from '@/lib/db/repos/connectionsRepo.js';
import { getModelInfo, getComboModels } from '../../sse/services/model.js';
import { forwardChat } from './forward.js';
import { NO_REPLAY_HEADER } from '../../../open-sse/config/ha.js';

export async function maybeForwardChat(request, body, target = null, exhausted = false) {
  if (!process.env.NINEROUTER_HA_CONFIG || request.headers.has('x-9router-ha-hop')) return null;
  const runtime = (await getAdapter()).ha?.runtime;
  if (!runtime?.config.peer) return null;
  async function available(model, visited = new Set()) {
    if (visited.has(model) || visited.size >= 16) return true; // Leave invalid cycles to normal routing.
    visited.add(model);
    const members = await getComboModels(model);
    if (members?.length) {
      for (const member of members) {
        const id = typeof member === 'string' ? member : member.fullModel || (member.provider && member.model ? `${member.provider}/${member.model}` : null);
        if (!id || await available(id, new Set(visited))) return true;
      }
      return false;
    }
    const info = await getModelInfo(model);
    if (!info?.provider) return true;
    return (await getProviderConnections({ provider: info.provider, isActive: true })).length > 0;
  }
  if (!exhausted && await available(body.model)) return null;
  try { return await forwardChat(runtime, request, body, target); }
  catch (error) { return Response.json({ error: { message: 'Peer unavailable; request was not replayed', type: 'ha_peer_unavailable' } }, { status: 503, headers: error.haAccepted === false && !error.haCancelled ? {} : { [NO_REPLAY_HEADER]: '1' } }); }
}

export async function forwardedTarget(request, body) {
  const target = request.headers.get('x-9router-ha-target');
  if (!target) return null;
  const runtime = (await getAdapter()).ha?.runtime;
  if (!runtime || request.headers.get('x-9router-ha-proof') !== runtime.forwardSecret) return null;
  async function contains(model, visited = new Set()) {
    if (model === target) return true;
    if (visited.has(model) || visited.size >= 16) return false;
    visited.add(model);
    const members = await getComboModels(model);
    if (!members) {
      const a = await getModelInfo(model), b = await getModelInfo(target);
      return a?.provider && a.provider === b?.provider && a.model === b.model;
    }
    for (const member of members) {
      const id = typeof member === 'string' ? member : member.fullModel || (member.provider && member.model ? `${member.provider}/${member.model}` : null);
      if (id && await contains(id, new Set(visited))) return true;
    }
    return false;
  }
  if (!await contains(body.model)) throw new Error('Forwarded target is not a member of the authorized combo');
  return target;
}
