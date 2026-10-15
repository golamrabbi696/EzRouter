// A Responses upstream that hits max_output_tokens ends the stream with
// response.incomplete instead of response.completed. Reasoning models (e.g. the
// OpenCode Free muse-spark models) burn a small cap on reasoning alone, so this
// is routine. Nothing recognised the event: Chat clients got finish_reason "stop"
// (stream) or "in_progress" (non-stream), Claude clients "end_turn", and every
// path reported zero usage, so a truncated turn looked like an empty clean answer.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  trackPendingRequest: vi.fn()
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
await import("../../open-sse/translator/index.js");
const { createSSETransformStreamWithLogger } = await import("../../open-sse/utils/stream.js");
const { convertResponsesStreamToJson } = await import("../../open-sse/transformer/streamToJsonConverter.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

const USAGE = { input_tokens: 1057, output_tokens: 64, total_tokens: 1121, output_tokens_details: { reasoning_tokens: 61 } };

function incompleteEvents({ reason = "max_output_tokens", text = "" } = {}) {
  const events = [
    { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [] } },
  ];
  if (text) {
    events.push(
      { type: "response.output_item.done", output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [] } },
      { type: "response.output_item.added", output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", content: [] } },
      { type: "response.output_text.delta", output_index: 1, item_id: "msg_1", delta: text },
      { type: "response.output_item.done", output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text }] } },
    );
  }
  events.push({
    type: "response.incomplete",
    response: { id: "resp_1", status: "incomplete", incomplete_details: { reason }, usage: USAGE },
  });
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function sseBody(raw) {
  const encoder = new TextEncoder();
  return new ReadableStream({ start(c) { c.enqueue(encoder.encode(raw)); c.close(); } });
}

async function runStream(raw, sourceFormat) {
  const ts = createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, sourceFormat, "opencode", null, null, "m");
  const out = await new Response(sseBody(raw).pipeThrough(ts)).text();
  return out.split("\n")
    .filter((l) => l.startsWith("data: ") && l.slice(6).trim() !== "[DONE]")
    .map((l) => JSON.parse(l.slice(6)));
}

function forcedCtx(raw, sourceFormat) {
  return {
    providerResponse: new Response(sseBody(raw), { headers: { "content-type": "text/event-stream" } }),
    sourceFormat,
    targetFormat: FORMATS.OPENAI_RESPONSES,
    provider: "opencode",
    model: "muse-spark-1.3-contributor-free",
    body: { model: "muse-spark-1.3-contributor-free", messages: [] },
    stream: false,
    requestStartTime: Date.now(),
    connectionId: "test-connection",
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    trackDone: vi.fn(),
    appendLog: vi.fn()
  };
}

describe("response.incomplete — streaming", () => {
  it("Chat client gets finish_reason length with the upstream usage", async () => {
    const chunks = await runStream(incompleteEvents(), FORMATS.OPENAI);
    const finish = chunks.find((c) => c.choices?.[0]?.finish_reason);
    expect(finish.choices[0].finish_reason).toBe("length");
    expect(finish.usage.completion_tokens).toBeGreaterThanOrEqual(64);
  });

  it("keeps partial text and still marks it truncated", async () => {
    const chunks = await runStream(incompleteEvents({ text: "2047 is" }), FORMATS.OPENAI);
    const text = chunks.map((c) => c.choices?.[0]?.delta?.content || "").join("");
    expect(text).toBe("2047 is");
    expect(chunks.at(-1).choices[0].finish_reason).toBe("length");
  });

  it("maps a content_filter cut to finish_reason content_filter", async () => {
    const chunks = await runStream(incompleteEvents({ reason: "content_filter" }), FORMATS.OPENAI);
    expect(chunks.find((c) => c.choices?.[0]?.finish_reason).choices[0].finish_reason).toBe("content_filter");
  });

  it("Claude client gets stop_reason max_tokens with non-zero usage", async () => {
    const events = await runStream(incompleteEvents(), FORMATS.CLAUDE);
    const delta = events.find((e) => e.type === "message_delta");
    expect(delta.delta.stop_reason).toBe("max_tokens");
    expect(delta.usage.output_tokens).toBeGreaterThan(0);
  });
});

describe("response.incomplete — non-streaming", () => {
  it("convertResponsesStreamToJson reports status incomplete, details and usage", async () => {
    const json = await convertResponsesStreamToJson(sseBody(incompleteEvents()));
    expect(json.status).toBe("incomplete");
    expect(json.incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect(json.usage).toMatchObject({ input_tokens: 1057, output_tokens: 64, total_tokens: 1121 });
  });

  it("completed streams keep their shape (no incomplete_details key)", async () => {
    const raw = [
      { type: "response.created", response: { id: "resp_2" } },
      { type: "response.completed", response: { id: "resp_2", status: "completed", usage: USAGE } },
    ].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    const json = await convertResponsesStreamToJson(sseBody(raw));
    expect(json.status).toBe("completed");
    expect(json).not.toHaveProperty("incomplete_details");
  });

  it("Chat client gets finish_reason length, not in_progress, with usage", async () => {
    const result = await handleForcedSSEToJson(forcedCtx(incompleteEvents(), FORMATS.OPENAI));
    const json = await result.response.json();
    expect(json.choices[0].finish_reason).toBe("length");
    expect(json.usage).toMatchObject({ prompt_tokens: 1057, completion_tokens: 64 });
  });

  it("Claude client gets stop_reason max_tokens with usage", async () => {
    const result = await handleForcedSSEToJson(forcedCtx(incompleteEvents({ text: "2047 is" }), FORMATS.CLAUDE));
    const json = await result.response.json();
    expect(json.stop_reason).toBe("max_tokens");
    expect(json.content.find((b) => b.type === "text").text).toBe("2047 is");
    expect(json.usage.output_tokens).toBe(64);
  });

  it("Responses client gets the incomplete status and reason back", async () => {
    const result = await handleForcedSSEToJson(forcedCtx(incompleteEvents(), FORMATS.OPENAI_RESPONSES));
    const json = await result.response.json();
    expect(json.status).toBe("incomplete");
    expect(json.incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect(json.usage.output_tokens).toBe(64);
  });
});
