// Offline routing matrix for opencode-go models.
//
// Drives the REAL handleChatCore guard + targetFormat resolution (open-sse/handlers/chatCore.js:86-94)
// end-to-end; only the executor's HTTP response is mocked. The assertion target is
// credentials.runtimeTransport — the exact field DefaultExecutor.buildUrl/buildHeaders read
// (open-sse/executors/default.js:106,150) to pick the endpoint and auth scheme — so a wrong
// guard decision shows up as the wrong baseUrl here, same as it would on the wire.
//
// Cells:
//   - deepseek × {openai, claude, openai-responses} × {bare, (max)} — the endpoint matrix
//     under dispute in #3278/#3332. Bare and suffixed cells must resolve identically.
//   - glm/kimi (chat-only) + (max) — regression cells: with the thinking suffix, the guard
//     must reject unsupported source endpoints, then use the translated target's supported
//     transport rather than falling through to the provider's chat default implicitly.
//   - minimax + (max) + claude — suffix must NOT block a genuinely declared format.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("uuid", () => ({
  v4: () => "00000000-0000-4000-8000-000000000000",
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

// image.js imports Agent from "undici" (not installed in some dev envs); the
// prefetch path is irrelevant to routing assertions.
vi.mock("../../open-sse/translator/concerns/image.js", () => ({
  encodeDataUri: (mimeType, base64) => `data:${mimeType};base64,${base64}`,
  parseDataUri: (url) => {
    const m = /^data:([^;]+);base64,(.*)$/.exec(url);
    return m ? { mimeType: m[1], base64: m[2] } : null;
  },
  fetchImageAsBase64: async () => null,
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const BASE = "https://opencode.ai/zen/go/v1";
const ENDPOINTS = {
  openai: `${BASE}/chat/completions`,
  claude: `${BASE}/messages`,
  "openai-responses": `${BASE}/responses`,
};

// Minimal non-stream provider JSON per target format — the mocked executor's response.
const RESPONSE_BY_FORMAT = {
  claude: {
    id: "msg_1", type: "message", role: "assistant", model: "test",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
  openai: {
    id: "chatcmpl-1", object: "chat.completion", model: "test",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
  "openai-responses": {
    id: "resp_1", object: "response", created_at: 0, status: "completed", model: "test",
    output: [{
      type: "message", id: "msg_1", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    }],
  },
};

async function route(model, sourceFormat) {
  executeMock.mockImplementationOnce(async ({ credentials }) => {
    const format = credentials.runtimeTransport?.format || "openai";
    const url = credentials.runtimeTransport?.baseUrl || ENDPOINTS.openai;
    return {
      response: new Response(JSON.stringify(RESPONSE_BY_FORMAT[format] || RESPONSE_BY_FORMAT.openai), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      url,
      headers: {},
      transformedBody: null,
    };
  });

  const credentials = { apiKey: "test-key", providerSpecificData: {} };
  const result = await handleChatCore({
    body: {
      model: `opencode-go/${model}`,
      stream: false,
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    },
    modelInfo: { provider: "opencode-go", model },
    credentials,
    connectionId: "ocg-route-test",
    sourceFormatOverride: sourceFormat,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
  });

  const { credentials: creds } = executeMock.mock.calls.at(-1)[0];
  const executorResult = await executeMock.mock.results.at(-1).value;
  return {
    result,
    runtimeTransport: creds.runtimeTransport ?? null,
    effectiveUrl: executorResult.url,
  };
}

describe("opencode-go DeepSeek routing contract (via real handleChatCore)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Upstream master routes DeepSeek on every declared format (openai + claude +
  // openai-responses) — verify we stay on that map, not the old chat-only map.
  for (const model of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
    for (const suffix of ["", "(max)"]) {
      const id = model + suffix;

      it(`routes ${id} + openai-format client to /chat/completions`, async () => {
        const { result, runtimeTransport } = await route(id, "openai");
        expect(result.success).toBe(true);
        expect(runtimeTransport?.baseUrl).toBe(ENDPOINTS.openai);
      });

      for (const fmt of ["claude", "openai-responses"]) {
        it(`routes ${id} + ${fmt}-format client to ${fmt === "claude" ? "/messages" : "/responses"}`, async () => {
          const { result, runtimeTransport } = await route(id, fmt);
          expect(result.success).toBe(true);
          expect(runtimeTransport?.baseUrl).toBe(ENDPOINTS[fmt]);
        });
      }
    }
  }
});

describe("opencode-go Muse Spark 1.3 routing contract (via real handleChatCore)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes 1.3 + responses-format client to /zen/go/v1/responses", async () => {
    const { result, runtimeTransport } = await route("muse-spark-1.3-contributor", "openai-responses");
    expect(result.success).toBe(true);
    expect(runtimeTransport?.baseUrl).toBe(ENDPOINTS["openai-responses"]);
  });

  it("routes 1.3 + claude-format client to /zen/go/v1/responses via the model target format", async () => {
    const { result, runtimeTransport } = await route("muse-spark-1.3-contributor", "claude");
    expect(result.success).toBe(true);
    expect(runtimeTransport?.baseUrl).toBe(ENDPOINTS["openai-responses"]);
  });

  it("routes 1.3 + Chat-format (openai) client to /zen/go/v1/responses via the model target format", async () => {
    const { result, runtimeTransport } = await route("muse-spark-1.3-contributor", "openai");
    expect(result.success).toBe(true);
    expect(runtimeTransport?.baseUrl).toBe(ENDPOINTS["openai-responses"]);
  });
});

describe("opencode-go thinking-suffix guard (regression)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Keep these original full titles stable: the differential regression gate keys cases by path and full_name.
  it("does NOT route chat-only glm-5.2(max) to /messages on a claude-format request", async () => {
    const { result, runtimeTransport, effectiveUrl } = await route("glm-5.2(max)", "claude");
    expect(result.success).toBe(true);
    expect(runtimeTransport?.format).toBe("openai");
    expect(effectiveUrl).toBe(ENDPOINTS.openai);
    expect(effectiveUrl).not.toBe(ENDPOINTS.claude);
  });

  it("does NOT route chat-only kimi-k2.6(max) to /responses on a responses-format request", async () => {
    const { result, runtimeTransport, effectiveUrl } = await route("kimi-k2.6(max)", "openai-responses");
    expect(result.success).toBe(true);
    expect(runtimeTransport?.format).toBe("openai");
    expect(effectiveUrl).toBe(ENDPOINTS.openai);
    expect(effectiveUrl).not.toBe(ENDPOINTS["openai-responses"]);
  });

  it("still routes minimax-m3(max) + claude-format client to /messages", async () => {
    const { result, runtimeTransport } = await route("minimax-m3(max)", "claude");
    expect(result.success).toBe(true);
    expect(runtimeTransport?.baseUrl).toBe(ENDPOINTS.claude);
  });

  it("does NOT route minimax-m3(max) (no responses support) to /responses", async () => {
    const { result, runtimeTransport, effectiveUrl } = await route("minimax-m3(max)", "openai-responses");
    expect(result.success).toBe(true);
    expect(runtimeTransport?.format).toBe("openai");
    expect(effectiveUrl).toBe(ENDPOINTS.openai);
    expect(effectiveUrl).not.toBe(ENDPOINTS["openai-responses"]);
  });
});
