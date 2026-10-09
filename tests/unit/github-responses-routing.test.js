/**
 * Regression test for #1062 and Copilot /responses routing:
 * - GitHub Copilot's /responses endpoint only serves OpenAI/codex models.
 * - Gemini/Claude models must never be routed/escalated there.
 * - gpt-6*, gpt-5.6*, gpt-5.5, gpt-5.4-mini, codex, and grok-4 models route
 *   directly to /responses without a failing /chat/completions attempt.
 * - Fallback catches unsupported_api_for_model and /v1/responses hints.
 * - executeWithResponsesEndpoint returns responseFormat: FORMATS.OPENAI_RESPONSES.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { GithubExecutor } from "../../open-sse/executors/github.js";
import { createErrorResult, parseUpstreamError } from "../../open-sse/utils/error.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const { proxyFetchMock } = vi.hoisted(() => ({ proxyFetchMock: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: proxyFetchMock,
}));

const proxyAwareFetch = proxyFetchMock;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("GithubExecutor.supportsResponsesEndpoint", () => {
  const exec = new GithubExecutor();

  it("excludes Gemini models from the /responses endpoint", () => {
    expect(exec.supportsResponsesEndpoint("gemini-3.1-pro-preview")).toBe(false);
    expect(exec.supportsResponsesEndpoint("gemini-3.1-pro-low")).toBe(false);
  });

  it("excludes Claude models from the /responses endpoint", () => {
    expect(exec.supportsResponsesEndpoint("claude-sonnet-4.6")).toBe(false);
    expect(exec.supportsResponsesEndpoint("claude-opus-4.7")).toBe(false);
  });

  it("allows OpenAI/codex models on the /responses endpoint", () => {
    expect(exec.supportsResponsesEndpoint("gpt-5.5-codex")).toBe(true);
    expect(exec.supportsResponsesEndpoint("o4-mini")).toBe(true);
    expect(exec.supportsResponsesEndpoint("gpt-4.1")).toBe(true);
    expect(exec.supportsResponsesEndpoint("gpt-6-luna")).toBe(true);
  });

  it("is null-safe", () => {
    expect(exec.supportsResponsesEndpoint(undefined)).toBe(true);
    expect(exec.supportsResponsesEndpoint("")).toBe(true);
  });
});

describe("GithubExecutor.isResponsesModel", () => {
  const exec = new GithubExecutor();

  it("detects gpt-6* models as responses models", () => {
    expect(exec.isResponsesModel("gpt-6-luna")).toBe(true);
    expect(exec.isResponsesModel("gpt-6-sol")).toBe(true);
    expect(exec.isResponsesModel("gpt-6-astra")).toBe(true);
    expect(exec.isResponsesModel("gpt-6.1-sol")).toBe(true);
  });

  it("detects gpt-5.6*, gpt-5.5, gpt-5.4-mini, and codex models", () => {
    expect(exec.isResponsesModel("gpt-5.6-luna")).toBe(true);
    expect(exec.isResponsesModel("gpt-5.6-sol")).toBe(true);
    expect(exec.isResponsesModel("gpt-5.6-terra")).toBe(true);
    expect(exec.isResponsesModel("gpt-5.5")).toBe(true);
    expect(exec.isResponsesModel("gpt-5.4-mini")).toBe(true);
    expect(exec.isResponsesModel("gpt-5.3-codex")).toBe(true);
    expect(exec.isResponsesModel("grok-4.7")).toBe(true);
    expect(exec.isResponsesModel("mai-code-v1")).toBe(true);
  });

  it("does not flag legacy chat models or excluded providers", () => {
    expect(exec.isResponsesModel("gpt-5.2")).toBe(false);
    expect(exec.isResponsesModel("gpt-5.4")).toBe(false);
    expect(exec.isResponsesModel("gpt-4.1")).toBe(false);
    expect(exec.isResponsesModel("gemini-2.5-pro")).toBe(false);
    expect(exec.isResponsesModel("claude-sonnet-4.6")).toBe(false);
    expect(exec.isResponsesModel(undefined)).toBe(false);
    expect(exec.isResponsesModel("")).toBe(false);
  });
});

describe("GithubExecutor.requiresMaxCompletionTokens", () => {
  const exec = new GithubExecutor();

  it("matches gpt-5+, gpt-6+, and o-series models", () => {
    expect(exec.requiresMaxCompletionTokens("gpt-5.2")).toBe(true);
    expect(exec.requiresMaxCompletionTokens("gpt-5.6-luna")).toBe(true);
    expect(exec.requiresMaxCompletionTokens("gpt-6-luna")).toBe(true);
    expect(exec.requiresMaxCompletionTokens("gpt-6.1-sol")).toBe(true);
    expect(exec.requiresMaxCompletionTokens("o3-mini")).toBe(true);
    expect(exec.requiresMaxCompletionTokens("o4-mini")).toBe(true);
  });

  it("does not match older models", () => {
    expect(exec.requiresMaxCompletionTokens("gpt-4.1")).toBe(false);
    expect(exec.requiresMaxCompletionTokens("claude-opus-4.7")).toBe(false);
  });
});

describe("GithubExecutor.execute routing", () => {
  it("routes gpt-6-luna directly to executeWithResponsesEndpoint", async () => {
    const exec = new GithubExecutor();
    const respSpy = vi
      .spyOn(exec, "executeWithResponsesEndpoint")
      .mockResolvedValue({ via: "responses" });
    const baseSpy = vi
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(exec)), "execute")
      .mockResolvedValue({ response: { status: 200 }, via: "chat" });

    const result = await exec.execute({ model: "gpt-6-luna", body: { messages: [] }, log: null });

    expect(respSpy).toHaveBeenCalled();
    expect(baseSpy).not.toHaveBeenCalled();
    expect(result.via).toBe("responses");
  });

  it("does NOT use /responses for a Gemini model even if it was wrongly cached as codex", async () => {
    const exec = new GithubExecutor();
    exec.knownCodexModels.add("gemini-3.1-pro-preview");

    const respSpy = vi
      .spyOn(exec, "executeWithResponsesEndpoint")
      .mockResolvedValue({ via: "responses" });
    const baseSpy = vi
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(exec)), "execute")
      .mockResolvedValue({ response: { status: 200 }, via: "chat" });

    const result = await exec.execute({ model: "gemini-3.1-pro-preview", body: { messages: [] }, log: null });

    expect(respSpy).not.toHaveBeenCalled();
    expect(baseSpy).toHaveBeenCalled();
    expect(result.via).toBe("chat");
  });

  it("falls back to /responses when chat/completions returns reasoning/responses error", async () => {
    const exec = new GithubExecutor();
    const errorMsg = 'Function tools with reasoning_effort are not supported for model in /v1/chat/completions. To use function tools, use /v1/responses';

    const respSpy = vi
      .spyOn(exec, "executeWithResponsesEndpoint")
      .mockResolvedValue({ via: "responses-fallback" });
    vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(exec)), "execute")
      .mockResolvedValue({
        response: new Response(errorMsg, { status: 400 }),
        via: "chat"
      });

    const result = await exec.execute({ model: "gpt-custom-preview", body: { messages: [] }, log: null });

    expect(respSpy).toHaveBeenCalled();
    expect(exec.knownCodexModels.has("gpt-custom-preview")).toBe(true);
    expect(result.via).toBe("responses-fallback");
  });

  it("returns responseFormat: FORMATS.OPENAI_RESPONSES from executeWithResponsesEndpoint", async () => {
    const exec = new GithubExecutor();
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response(JSON.stringify({ id: "resp_123" }), { status: 200 });
      const result = await exec.executeWithResponsesEndpoint({
        model: "gpt-6-luna",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { accessToken: "test-token" },
        signal: null,
        log: null
      });
      expect(result.responseFormat).toBe(FORMATS.OPENAI_RESPONSES);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("GitHub Claude prompt-limit preflight", () => {
  it("rejects an oversized prompt before creating a message", async () => {
    proxyFetchMock.mockReset();
    proxyFetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ input_tokens: 200001 }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const exec = new GithubExecutor();

    const result = await exec.executeWithMessagesEndpoint({
      model: "claude-fable-5",
      body: { messages: [{ role: "user", content: "x".repeat(400000) }] },
      stream: true,
      credentials: { copilotToken: "test-token" },
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    expect(proxyFetchMock).toHaveBeenCalledTimes(1);
    expect(proxyFetchMock.mock.calls[0][0]).toBe("https://api.githubcopilot.com/v1/messages/count_tokens");
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toMatchObject({
      error: { code: "context_length_exceeded" },
    });
  });

  it("does not add token-count latency to small prompts", async () => {
    proxyFetchMock.mockReset();
    proxyFetchMock.mockResolvedValueOnce(new Response("bad request", { status: 400 }));
    const exec = new GithubExecutor();

    await exec.executeWithMessagesEndpoint({
      model: "claude-fable-5",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: true,
      credentials: { copilotToken: "test-token" },
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    expect(proxyFetchMock).toHaveBeenCalledTimes(1);
    expect(proxyFetchMock.mock.calls[0][0]).toBe("https://api.githubcopilot.com/v1/messages");
  });

  it("allows a prompt exactly at the upstream limit", async () => {
    proxyFetchMock.mockReset();
    proxyFetchMock
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ input_tokens: 200000 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response("generated", { status: 200 }));
    const exec = new GithubExecutor();

    await exec.executeWithMessagesEndpoint({
      model: "claude-fable-5",
      body: { messages: [{ role: "user", content: "x".repeat(400000) }] },
      stream: true,
      credentials: { copilotToken: "test-token" },
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    expect(proxyFetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.githubcopilot.com/v1/messages/count_tokens",
      "https://api.githubcopilot.com/v1/messages",
    ]);
  });

  it("continues when the token-count endpoint is unavailable", async () => {
    proxyFetchMock.mockReset();
    proxyFetchMock
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("generated", { status: 200 }));
    const warn = vi.fn();
    const exec = new GithubExecutor();

    await exec.executeWithMessagesEndpoint({
      model: "claude-fable-5",
      body: { messages: [{ role: "user", content: "x".repeat(400000) }] },
      stream: true,
      credentials: { copilotToken: "test-token" },
      log: { debug: vi.fn(), warn },
    });

    expect(proxyFetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.githubcopilot.com/v1/messages/count_tokens",
      "https://api.githubcopilot.com/v1/messages",
    ]);
    expect(warn).toHaveBeenCalledWith("GITHUB", "Prompt token preflight returned 503; continuing");
  });

  it("preserves context_length_exceeded through default executor parsing", async () => {
    const upstream = new Response(JSON.stringify({
      error: {
        message: "Prompt is 200001 tokens; maximum is 200000.",
        type: "invalid_request_error",
        code: "context_length_exceeded",
      },
    }), { status: 400, headers: { "content-type": "application/json" } });

    const parsed = await parseUpstreamError(upstream, new GithubExecutor());
    const result = createErrorResult(parsed.statusCode, parsed.message, undefined, parsed.code);

    expect(await result.response.json()).toMatchObject({
      error: {
        message: "Prompt is 200001 tokens; maximum is 200000.",
        code: "context_length_exceeded",
      },
    });
  });
});

describe("GithubExecutor unsupported params on upstream routes", () => {
  const cases = [
    { model: "gpt-5.4", route: "chat" },
    { model: "gpt-5.4", route: "fallback" },
    { model: "gpt-5.4", route: "cached" },
    { model: "gpt-6.1-sol", route: "direct" },
  ];

  it.each(cases)("strips temperature for $model on the $route route", async ({ model, route }) => {
    const exec = new GithubExecutor();
    const body = {
      model,
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.7,
    };
    if (route === "cached") exec.knownCodexModels.add(model);
    if (route === "fallback") {
      proxyAwareFetch.mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { message: "not accessible via the /chat/completions endpoint" } }),
        { status: 400 }
      ));
    }
    proxyAwareFetch.mockResolvedValueOnce(new Response("data: [DONE]\n\n", { status: 200 }));

    const result = await exec.execute({
      model, body, stream: true, credentials: { accessToken: "test-token" },
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(route === "fallback" ? 2 : 1);
    for (const [, options] of proxyAwareFetch.mock.calls) {
      const sent = JSON.parse(options.body);
      expect(sent).not.toHaveProperty("temperature");
      expect(sent.model).toBe(model);
    }
    expect(result.url).toBe(route === "chat" ? exec.config.baseUrl : exec.config.responsesUrl);
    expect(body.temperature).toBe(0.7);
    if (route !== "chat") {
      expect(result.transformedBody.input).toEqual([{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      }]);
    }
  });

  it.each([
    { model: "gpt-6.1-sol", stripTemperature: true },
    { model: "gpt-5.3-codex", stripTemperature: false },
  ])("filters an already-Responses-format request for $model", async ({ model, stripTemperature }) => {
    const exec = new GithubExecutor();
    exec.knownCodexModels.add(model);
    const body = {
      input: [{ role: "user", content: "hello" }],
      temperature: 0.7,
      max_output_tokens: 1024,
    };
    proxyAwareFetch.mockResolvedValueOnce(new Response("data: [DONE]\n\n", { status: 200 }));

    await exec.execute({ model, body, stream: true, credentials: { accessToken: "test-token" } });

    const sent = JSON.parse(proxyAwareFetch.mock.calls[0][1].body);
    if (stripTemperature) expect(sent).not.toHaveProperty("temperature");
    else expect(sent.temperature).toBe(0.7);
    expect(sent.input).toEqual(body.input);
    expect(sent.max_output_tokens).toBe(1024);
    expect(body.temperature).toBe(0.7);
  });
});
