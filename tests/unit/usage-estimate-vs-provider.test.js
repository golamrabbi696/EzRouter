/**
 * Regression for #5056: the request-body token estimate must never win the
 * max-merge against the provider's authoritative usage.
 *
 * Scenario: an OpenAI-compatible provider that follows the streaming convention
 * (finish chunk carries no usage, usage arrives in a trailing chunk) and a
 * request body much larger than what the provider actually consumed.
 */
import { describe, it, expect } from "vitest";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

const encoder = new TextEncoder();

function sseStream(lines) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines.join("\n") + "\n"));
      controller.close();
    },
  });
}

async function runPassthrough(body, providerLines) {
  let captured = null;
  const transformer = createPassthroughStreamWithLogger(
    "test-provider",
    null,
    "test-model",
    null,
    body,
    (content, usage) => { captured = { content, usage }; }
  );

  // createSSEStream returns a TransformStream: pipe the provider stream through it.
  const piped = sseStream(providerLines).pipeThrough(transformer);
  const reader = piped.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
  return captured;
}

// Body large enough that ceil(chars/4) + 2000 exceeds the provider's real count.
const BIG_BODY = { model: "m", messages: [{ role: "user", content: "x".repeat(40000) }] };

const PROVIDER_LINES = [
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "PONG" }, finish_reason: null }] })}`,
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
  // Authoritative usage arrives after the finish chunk (stream_options.include_usage).
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 } })}`,
  "data: [DONE]",
];

describe("stream usage accounting (#5056)", () => {
  it("reports the provider's prompt_tokens, not the request-body estimate", async () => {
    const captured = await runPassthrough(BIG_BODY, PROVIDER_LINES);
    expect(captured).not.toBeNull();
    expect(captured.usage).toBeTruthy();
    expect(captured.usage.prompt_tokens).toBe(1000);
    expect(captured.usage.completion_tokens).toBe(10);
  });
});
