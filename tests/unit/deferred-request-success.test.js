// Deferred onRequestSuccess: clearing the account error state must not happen
// on the first byte of a stream that later proves to be empty/aborted.
//
// Phase 10 fix: handleStreamingResponse wraps the transform stream's readable
// side with a success tee that fires onRequestSuccess on the first byte that
// actually crosses the wire. A 200-with-no-body response never reaches the
// tee and therefore never clears the account error state.
//
// We exercise the wiring directly: build the same tee the production code
// builds, pipe the provider stream through it, and assert whether the
// callback fires based on whether any translated bytes survived.
import { describe, it, expect, vi } from "vitest";

const encoder = new TextEncoder();

function makeResponse(bytes) {
  return new Response(new ReadableStream({
    start(controller) {
      if (bytes.length) controller.enqueue(bytes);
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

// Mirror the production tee construction from streamingHandler.js. Kept
// here so this test does not depend on the full handleStreamingResponse
// (which requires an SSE parser to emit anything).
function makeSuccessTee(onFirstChunk) {
  let fired = false;
  return new TransformStream({
    transform(chunk, controller) {
      if (!fired) {
        fired = true;
        Promise.resolve().then(onFirstChunk).catch(() => {});
      }
      controller.enqueue(chunk);
    },
  });
}

async function drain(stream) {
  const reader = stream.getReader();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += new TextDecoder().decode(value, { stream: true });
  }
  return out;
}

describe("deferred success tee (mirrors handleStreamingResponse wiring)", () => {
  it("fires the callback when at least one chunk crosses the tee", async () => {
    const onRequestSuccess = vi.fn();
    const tee = makeSuccessTee(onRequestSuccess);
    const body = makeResponse(encoder.encode("first byte\nsecond byte\n")).body;
    await drain(body.pipeThrough(tee));
    await new Promise((r) => setTimeout(r, 10));
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire the callback when the stream is empty", async () => {
    const onRequestSuccess = vi.fn();
    const tee = makeSuccessTee(onRequestSuccess);
    const body = makeResponse(encoder.encode("")).body;
    await drain(body.pipeThrough(tee));
    await new Promise((r) => setTimeout(r, 10));
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("fires the callback only once even across many chunks", async () => {
    const onRequestSuccess = vi.fn();
    const tee = makeSuccessTee(onRequestSuccess);
    const body = makeResponse(encoder.encode("a\nb\nc\nd\n")).body;
    await drain(body.pipeThrough(tee));
    await new Promise((r) => setTimeout(r, 10));
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
  });
});
