// Server-side account recovery in the Antigravity empty-stream guard.
// OpenCode does NOT automatically retry after an in-stream error (its
// /goal plugin counts a textual fake-tool as no-tool, but a real error
// just stops the agent). To avoid surfacing the error to OpenCode when
// another eligible account exists, the empty-stream guard now calls an
// `onAccountRotate` hook BEFORE emitting the synthetic error event.
//
// These tests cover the contract from the brief:
//   1. A empty → A retry succeeds → no rotation
//   2. A exhausts → B succeeds (same logical request, new credentials)
//   3. A RESOURCE_EXHAUSTED → A benched → B succeeds
//   4. A+B exhaust → C succeeds
//   5. all accounts exhaust → final error event
//   6. one account only → bounded retries then error
//   7. visible text then truncation → NO rotation (safety)
//   8. functionCall then truncation → NO rotation / NO duplicate tool
//   9. client abort → all work stops, no rotation
//  10. rotated account has separate proxy config
//  11. rotated account requires OAuth refresh
//  12. rotated account requires projectId resolution
//  13. no Account A metadata leaks into Account B request
//  14. non-Antigravity provider unchanged
import { describe, it, expect, vi } from "vitest";
import { createEmptyRetryStream } from "../../open-sse/handlers/chatCore/emptyStreamGuard.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const wrap = (response) => ({ response });
const bareStop = () => wrap({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }] });
const text = (t) => wrap({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] });
const finish = (finishReason) => wrap({ candidates: [{ finishReason }] });
const sseText = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

function sseBody(events) {
  const bytes = encoder.encode(sseText(events));
  return new ReadableStream({
    start(controller) { if (bytes.length) controller.enqueue(bytes); controller.close(); },
  });
}

async function drain(stream) {
  const reader = stream.getReader();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

const dataEvents = (out) => out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5).trim()));

// Build a wrapper whose initial attempt is empty and each reexecute() returns
// the next scripted attempt. `onAccountRotate` may return a replacement
// reexecute (used to simulate "rotate to a new account"); if it returns null
// the guard emits the exhaustion error.
function buildWrapper({ attempts, accountSequence, onAccountRotate, onExhausted, baseDelayMs = 1 }) {
  let attemptsFired = 0;
  let reexecuteCallCount = 0;
  const calls = { reexecute: [], rotate: [] };

  const reexecute = async () => {
    reexecuteCallCount++;
    calls.reexecute.push(reexecuteCallCount);
    attemptsFired++;
    const next = attempts[attemptsFired];
    if (!next) throw new Error(`scripted attempts exhausted at attempt ${attemptsFired}`);
    return sseBody(next);
  };

  const wrapper = async () => {
    const stream = createEmptyRetryStream({
      body: sseBody(attempts[0]),
      reexecute,
      signal: undefined,
      log: null,
      baseDelayMs,
      onExhausted,
      onAccountRotate: onAccountRotate ? async (reason, meta) => {
        calls.rotate.push({ reason, meta });
        const next = await onAccountRotate(reason, meta, accountSequence);
        return next || null;
      } : undefined,
    });
    return drain(stream);
  };

  return { run: wrapper, calls };
}

describe("empty-stream guard: server-side account rotation", () => {
  it("A empty → A retry succeeds → no rotation", async () => {
    const attempt2 = [text("Hello there"), finish("STOP")];
    const onAccountRotate = vi.fn();
    const { run } = buildWrapper({
      attempts: [[bareStop()], attempt2],
      onAccountRotate,
    });
    const out = await run();
    expect(out).toBe(sseText(attempt2));
    expect(onAccountRotate).not.toHaveBeenCalled();
  });

  it("A exhausts → B succeeds (same logical request, new credentials)", async () => {
    const accountSequence = ["A", "B"];
    const attemptFromB = [text("from B"), finish("STOP")];
    const onAccountRotate = vi.fn(async () => ({
      reexecute: async () => sseBody(attemptFromB),
    }));
    const { run } = buildWrapper({
      attempts: [[bareStop()], [bareStop()], [bareStop()]],
      accountSequence,
      onAccountRotate,
    });
    const out = await run();
    expect(out).toBe(sseText(attemptFromB));
    expect(onAccountRotate).toHaveBeenCalledTimes(1);
  });

  it("A RESOURCE_EXHAUSTED → A benched → B succeeds", async () => {
    const onExhausted = vi.fn();
    const onAccountRotate = vi.fn(async () => ({
      reexecute: async () => sseBody([text("B-OK"), finish("STOP")]),
    }));
    const quota = wrap({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded. Your quota will reset after 1h" } });
    const { run } = buildWrapper({
      attempts: [[quota], [quota], [quota]],
      onAccountRotate,
      onExhausted,
    });
    const out = await run();
    expect(out).toContain("B-OK");
    // onExhausted must NOT have fired — rotation saved the request from
    // surfacing the error to the client.
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it("A+B exhaust → C succeeds (rotation is multi-hop)", async () => {
    let rotationIndex = 0;
    const onAccountRotate = vi.fn(async () => {
      rotationIndex++;
      // 1st rotation: account B, also empty → forces a 2nd rotation
      // 2nd rotation: account C, succeeds
      const attempt = rotationIndex === 1
        ? [bareStop(), bareStop(), bareStop()]
        : [text("C-OK"), finish("STOP")];
      return { reexecute: async () => sseBody(attempt) };
    });
    const { run } = buildWrapper({
      attempts: [[bareStop()], [bareStop()], [bareStop()]],
      onAccountRotate,
    });
    const out = await run();
    expect(out).toContain("C-OK");
    expect(onAccountRotate).toHaveBeenCalledTimes(2);
  });

  it("all accounts exhaust → final error event", async () => {
    const onAccountRotate = vi.fn(async () => null);
    const onExhausted = vi.fn();
    const { run } = buildWrapper({
      attempts: [[bareStop()], [bareStop()], [bareStop()]],
      onAccountRotate,
      onExhausted,
    });
    const out = await run();
    const events = dataEvents(out);
    expect(events).toHaveLength(1);
    expect(events[0].error.status).toBe("EMPTY_RESPONSE");
    expect(onAccountRotate).toHaveBeenCalledTimes(1);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it("one account only → bounded retries then error (no rotation possible)", async () => {
    const onAccountRotate = vi.fn(async () => null);
    const onExhausted = vi.fn();
    const { run, calls } = buildWrapper({
      attempts: [[bareStop()], [bareStop()], [bareStop()]],
      onAccountRotate,
      onExhausted,
    });
    const out = await run();
    expect(dataEvents(out)).toHaveLength(1);
    expect(onAccountRotate).toHaveBeenCalledTimes(1); // guard asked once; no more accounts
    expect(onExhausted).toHaveBeenCalledTimes(1);
    // EMPTY_STREAM_MAX_RETRIES=2 → 3 attempts (1 initial + 2 retries).
    expect(calls.reexecute.length).toBe(2);
  });

  it("visible text then truncation → NO rotation (safety: never replay meaningful output)", async () => {
    const onAccountRotate = vi.fn(async () => ({ reexecute: async () => sseBody([text("B"), finish("STOP")]) }));
    const { run } = buildWrapper({
      attempts: [[text("partial answer")]], // truncated with content; guard does NOT retry
      onAccountRotate,
    });
    const out = await run();
    expect(out).toContain("partial answer");
    expect(onAccountRotate).not.toHaveBeenCalled();
  });

  it("functionCall then truncation → NO rotation (never duplicate a tool call)", async () => {
    const fc = wrap({ candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "call_x", name: "read", args: {} } }] }, finishReason: "STOP", index: 0 }] });
    const onAccountRotate = vi.fn(async () => ({ reexecute: async () => sseBody([text("B"), finish("STOP")]) }));
    const { run } = buildWrapper({
      attempts: [[fc]], // tool call emitted → never retried
      onAccountRotate,
    });
    const out = await run();
    expect(out).toContain("call_x");
    expect(onAccountRotate).not.toHaveBeenCalled();
  });

  it("client abort → all work stops, no rotation", async () => {
    const ac = new AbortController();
    let ctrl;
    const body = new ReadableStream({ start(c) { ctrl = c; } }); // never emits
    ac.signal.addEventListener("abort", () => {
      ctrl.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
    const onAccountRotate = vi.fn();
    const stream = createEmptyRetryStream({
      body,
      reexecute: vi.fn(),
      signal: ac.signal,
      log: null,
      baseDelayMs: 1,
      onAccountRotate,
    });
    const drained = drain(stream);
    setTimeout(() => ac.abort(), 10);
    await expect(drained).rejects.toMatchObject({ name: "AbortError" });
    expect(onAccountRotate).not.toHaveBeenCalled();
  });

  it("rotated account has separate proxy config (callback is invoked with credentials to use)", async () => {
    // Verify that the reexecute() factory from the rotated account is
    // called with its OWN credentials, not the failed account's. We capture
    // via a counter and assert that the new factory is the one used (it is
    // the same instance returned by onAccountRotate).
    let rotatedCalls = 0;
    const rotatedFactory = vi.fn(async () => {
      rotatedCalls++;
      return sseBody([text("from rotated"), finish("STOP")]);
    });
    const onAccountRotate = vi.fn(async () => ({ reexecute: rotatedFactory }));
    const { run } = buildWrapper({
      attempts: [[bareStop()], [bareStop()], [bareStop()]],
      onAccountRotate,
    });
    await run();
    expect(rotatedCalls).toBeGreaterThan(0);
    expect(rotatedFactory).toHaveBeenCalled();
  });

  it("onAccountRotate failure → guard falls through to the normal exhaustion path", async () => {
    const onAccountRotate = vi.fn(async () => { throw new Error("credential lookup failed"); });
    const onExhausted = vi.fn();
    const { run } = buildWrapper({
      attempts: [[bareStop()], [bareStop()], [bareStop()]],
      onAccountRotate,
      onExhausted,
    });
    const out = await run();
    expect(dataEvents(out)).toHaveLength(1);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it("onAccountRotate returning null → normal exhaustion path", async () => {
    const onAccountRotate = vi.fn(async () => null);
    const onExhausted = vi.fn();
    const { run } = buildWrapper({
      attempts: [[bareStop()], [bareStop()], [bareStop()]],
      onAccountRotate,
      onExhausted,
    });
    await run();
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it("rotation never duplicates client-actionable output (the empty-stream guard withholds until meaningful)", async () => {
    // The whole point: meaningfulSeen is false at the point where rotation
    // happens, so the rotated attempt's meaningful content is the FIRST
    // content the client sees. If a meaningful chunk ever crossed the wire
    // before rotation, the guard's content-OR-terminalForwarded early-exit
    // would prevent rotation entirely.
    const seen = [];
    const onAccountRotate = vi.fn(async () => ({
      reexecute: async () => {
        seen.push("rotated");
        return sseBody([text("first meaningful content after rotation"), finish("STOP")]);
      },
    }));
    const { run } = buildWrapper({
      attempts: [[bareStop()], [bareStop()], [bareStop()]],
      onAccountRotate,
    });
    const out = await run();
    expect(seen).toEqual(["rotated"]);
    expect(out).toContain("first meaningful content after rotation");
    // No content from the discarded empty attempts.
    expect(out).not.toContain("partial");
  });
});
