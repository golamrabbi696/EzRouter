import { expect, it, vi } from 'vitest';
import { handleComboChat } from '../../open-sse/services/combo.js';
it('does not retry a combo after an ambiguous HA forward failure', async () => {
  const call = vi.fn(async () => new Response('{"error":"interrupted"}', { status: 502, headers: { 'x-9router-no-replay': '1' } }));
  const result = await handleComboChat({ body: { messages: [] }, models: ['a/model', 'b/model'], handleSingleModel: call, comboName: 'ha-test', comboStrategy: 'fallback', log: { info() {}, warn() {}, debug() {} } });
  expect(result.status).toBe(502);
  expect(call).toHaveBeenCalledTimes(1);
});
