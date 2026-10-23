export function sseChunk(data) {
  // Error frames must carry a "type" key or OpenAI-compatible clients drop them.
  if (data && typeof data === "object" && data.error && !data.type) {
    data = { type: "error", ...data };
  }
  return `data: ${JSON.stringify(data)}\n\n`;
}

// Build OpenAI chat.completion.chunk SSE frame. Key order: id, object, created, model, choices.
export function chatChunkSse({ id, created, model, delta, finishReason = null }) {
  return sseChunk({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}
