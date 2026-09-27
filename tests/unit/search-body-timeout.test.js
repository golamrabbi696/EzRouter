import dns from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleChatSearch } from "../../open-sse/handlers/search/chatSearch.js";
import { handleSearchCore } from "../../open-sse/handlers/search/index.js";

// Upstream sends headers, then never finishes the body. Like undici, aborting the
// request signal errors the body stream with an AbortError.
function stalledResponse(signal) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"response":'));
      signal?.addEventListener(
        "abort",
        () => controller.error(new DOMException("This operation was aborted", "AbortError")),
        { once: true }
      );
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } });
}

const AG_ANSWER = {
  response: {
    candidates: [
      {
        content: { parts: [{ text: "answer" }] },
        groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.com/a", title: "A" } }] },
      },
    ],
  },
};

const XQUIK = {
  id: "xquik",
  baseUrl: "https://xquik.com/api/v1/x/tweets/search",
  method: "GET",
  authType: "apikey",
  searchTypes: ["x"],
  defaultMaxResults: 5,
  maxMaxResults: 100,
  timeoutMs: 50,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("search upstream timeout covers the response body", () => {
  it("chat search (antigravity): headers then a stalled body → 504 after the request timeout, not a hang", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => stalledResponse(init.signal)));
    const log = { warn: vi.fn(), error: vi.fn() };

    const pending = handleChatSearch({
      provider: "antigravity",
      query: "29/12 duong lich",
      credentials: { accessToken: "token", projectId: "project" },
      log,
    });
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(pending).resolves.toMatchObject({ success: false, status: 504, error: "Upstream timeout" });
    expect(log.warn).toHaveBeenCalledWith("[chatSearch] timeout provider=antigravity");
  });

  it("chat search (antigravity): a normal answer still succeeds and leaves no timer behind", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(AG_ANSWER), { status: 200 })));

    const result = await handleChatSearch({
      provider: "antigravity",
      query: "q",
      credentials: { accessToken: "token", projectId: "project" },
    });

    expect(result).toMatchObject({ success: true, status: 200 });
    expect(result.data.answer.text).toBe("answer");
    expect(result.data.results[0].url).toBe("https://example.com/a");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("chat search: a body that is not JSON is still reported as an invalid upstream response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>oops</html>", { status: 200 })));

    const result = await handleChatSearch({
      provider: "antigravity",
      query: "q",
      credentials: { accessToken: "token", projectId: "project" },
    });

    expect(result).toEqual({ success: false, status: 502, error: "Invalid upstream response (status 200)" });
  });

  it("provider search: headers then a stalled body → 504 once the provider timeout elapses", async () => {
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => stalledResponse(init.signal)));
    const log = { info: vi.fn(), error: vi.fn() };

    const started = Date.now();
    const result = await handleSearchCore({
      body: { query: "release notes", max_results: 5 },
      provider: { id: "xquik" },
      providerConfig: XQUIK,
      credentials: { apiKey: "xq_test_key" },
      log,
    });

    expect(result).toMatchObject({ success: false, status: 504 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(log.error).toHaveBeenCalledWith("SEARCH", expect.stringContaining("xquik timeout"));
  });
});
