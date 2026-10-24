import { describe, it, expect } from "vitest";

import { stripUnsupportedParams } from "../../open-sse/translator/concerns/paramSupport.js";

describe("stripUnsupportedParams", () => {
  it("downgrades json_schema to json_object and injects schema system message for DeepSeek", () => {
    const schema = { type: "object", properties: { city: { type: "string" } } };
    const body = {
      response_format: { type: "json_schema", json_schema: { name: "geo", schema } },
      messages: [{ role: "user", content: "Capital of France?" }],
    };
    stripUnsupportedParams("deepseek", "deepseek-chat", body);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "Respond only with a JSON object that matches this JSON schema: " + JSON.stringify(schema),
    });
    expect(body.messages[1]).toEqual({ role: "user", content: "Capital of France?" });
  });

  it("flattens Cloudflare AI OpenAI content-part arrays", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello " },
            { type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
            { type: "text", text: "world" },
          ],
        },
      ],
    };

    expect(() => stripUnsupportedParams("cloudflare-ai", "@cf/meta/llama-3.1-8b-instruct", body)).not.toThrow();
    expect(body.messages[0].content).toBe("hello world");
  });

  it("drops the Claude Code `diagnostics` telemetry field for Claude models", () => {
    const body = {
      model: "claude-opus-5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
      diagnostics: { client: "cli" },
    };

    stripUnsupportedParams("claude", "claude-opus-5", body);

    expect(body.diagnostics).toBeUndefined();
    expect(body.messages).toHaveLength(1);
    expect(body.max_tokens).toBe(16);
  });

  it("leaves `diagnostics` intact for non-Claude models", () => {
    const body = { diagnostics: { client: "cli" } };

    stripUnsupportedParams("openai", "gpt-5", body);

    expect(body.diagnostics).toEqual({ client: "cli" });
  });

  it("keeps every Cloudflare message valid after flattening content parts", () => {
    const body = { messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", tool_calls: [{ id: "call_1" }] },
      { content: [{ type: "text", text: "orphan" }] },
    ] };
    stripUnsupportedParams("cloudflare-ai", "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", body);
    expect(body.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1" }] },
    ]);
  });

  it.each(["gpt-5.4", "gpt-5.4-mini", "gpt-5.9", "gpt-5.10", "gpt-6.0", "gpt-6.1-sol", "gpt-6.10"])("drops unsupported GitHub params for %s", (model) => {
    const body = { temperature: 0.7, top_p: 1 };

    stripUnsupportedParams("github", model, body);

    expect(body).toEqual({ top_p: 1 });
  });

  it.each(["gpt-4.1", "gpt-5", "gpt-5.0", "gpt-5.3-codex", "gpt-7.0", "gpt-5.4invalid"])("preserves temperature outside the GitHub version range for %s", (model) => {
    const body = { temperature: 0.7 };
    stripUnsupportedParams("github", model, body);
    expect(body).toEqual({ temperature: 0.7 });
  });

  it("preserves temperature for other providers", () => {
    const body = { temperature: 0.7 };
    stripUnsupportedParams("openai", "gpt-6.1-sol", body);
    expect(body).toEqual({ temperature: 0.7 });
  });

  it("clamps VolcEngine Ark GLM max token fields to the model output ceiling", () => {
    const body = {
      max_tokens: 131072,
      max_completion_tokens: 131072,
      max_output_tokens: 131072,
    };

    stripUnsupportedParams("volcengine-ark", "GLM-5.2", body);

    expect(body).toEqual({
      max_tokens: 128000,
      max_completion_tokens: 128000,
      max_output_tokens: 128000,
    });
  });

  it("keeps VolcEngine Ark GLM max tokens when already under the ceiling", () => {
    const body = { max_tokens: 64000 };

    stripUnsupportedParams("volcengine-ark", "GLM-5.2", body);

    expect(body.max_tokens).toBe(64000);
  });

  it("drops reasoning_effort/reasoning for custom OpenAI-compatible providers (#3008)", () => {
    const body = { reasoning_effort: "medium", reasoning: { effort: "medium" }, temperature: 0.7 };

    stripUnsupportedParams("openai-compatible-responses-b7531984", "gpt-5.6-sol", body);

    expect(body.reasoning_effort).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
    expect(body.temperature).toBe(0.7); // unrelated param preserved
  });

  it("does NOT drop reasoning_effort for real reasoning providers", () => {
    const body = { reasoning_effort: "high", model: "deepseek-reasoner" };

    stripUnsupportedParams("deepseek", "deepseek-reasoner", body);

    expect(body.reasoning_effort).toBe("high"); // preserved for providers that support it
  });

  it("renames max_tokens → max_completion_tokens for OpenAI gpt-5.x (#2830)", () => {
    const body = { max_tokens: 4096, model: "gpt-5.6-luna" };

    stripUnsupportedParams("openai", "gpt-5.6-luna", body);

    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBe(4096);
  });

  it("strips reasoning params for xAI grok-composer models", () => {
    const body = {
      reasoning_effort: "medium",
      reasoning: { effort: "medium" },
      thinking: { type: "enabled", budget_tokens: 8192 },
      messages: [{ role: "user", content: "hi" }],
    };

    stripUnsupportedParams("xai", "grok-composer-2.5-fast", body);

    expect(body.reasoning_effort).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.messages).toHaveLength(1);
  });

  it("drops replayed reasoning fields from assistant messages for strict providers", () => {
    const makeBody = () => ({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "hello",
          reasoning_content: "thinking...",
          reasoning: "thinking...",
          reasoning_details: [{ text: "thinking..." }],
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
        { role: "user", content: "again", reasoning_content: "user-side field stays" },
      ],
    });

    for (const [provider, model] of [
      ["groq", "openai/gpt-oss-120b"],
      ["mistral", "codestral-latest"],
      ["cerebras", "gpt-oss-120b"],
    ]) {
      const body = makeBody();
      stripUnsupportedParams(provider, model, body);
      expect(body.messages[1]).toEqual({
        role: "assistant",
        content: "hello",
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
      });
      // only assistant turns are touched
      expect(body.messages[2].reasoning_content).toBe("user-side field stays");
    }
  });

  it("leaves reasoning fields alone for providers that accept or require them", () => {
    const body = {
      messages: [{ role: "assistant", content: "hello", reasoning_content: "thinking..." }],
    };

    stripUnsupportedParams("deepseek", "deepseek-reasoner", body);
    stripUnsupportedParams("openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free", body);

    expect(body.messages[0].reasoning_content).toBe("thinking...");
  });

  it("drops response_format for OpenCode Go's deepseek family (both json_schema and json_object)", () => {
    const formats = [
      { type: "json_schema", json_schema: { name: "session_title", strict: true, schema: { type: "object" } } },
      { type: "json_object" },
    ];

    for (const model of ["deepseek-v4.1-flash", "deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4-pro"]) {
      for (const response_format of formats) {
        const body = { messages: [{ role: "user", content: "hi" }], response_format };
        stripUnsupportedParams("opencode-go", model, body);
        expect(body.response_format).toBeUndefined();
        expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
      }
    }
  });

  it("keeps response_format for OpenCode Go models that serve it", () => {
    const response_format = { type: "json_schema", json_schema: { name: "t", schema: { type: "object" } } };

    for (const model of ["glm-5.3-flash", "glm-5.3", "kimi-k3", "mimo-v2.6-flash", "minimax-m3", "qwen3.8-flash", "grok-4.7", "muse-spark-1.3-contributor"]) {
      const body = { messages: [{ role: "user", content: "hi" }], response_format };
      stripUnsupportedParams("opencode-go", model, body);
      expect(body.response_format).toBe(response_format);
    }
  });

  it("leaves response_format alone for other providers fronting deepseek ids", () => {
    const response_format = { type: "json_schema", json_schema: { name: "t", schema: { type: "object" } } };

    for (const [provider, model] of [
      // ["deepseek", "deepseek-reasoner"], // now converts json_schema -> json_object (see #5139)
      ["opencode-zen", "deepseek-v4.1-flash"],
      ["openrouter", "deepseek/deepseek-v3.2"],
    ]) {
      const body = { messages: [{ role: "user", content: "hi" }], response_format };
      stripUnsupportedParams(provider, model, body);
      expect(body.response_format).toBe(response_format);
    }
  });

  // Claude Code sends output_config.task_budget (task budgets beta) on its requests.
  // OpenCode Go's Claude lane rejects that field even with its own task-budgets-2026-03-13
  // flag, so it is stripped; context_management is NOT stripped because the upstream does
  // support context editing once default.js forwards the paired anthropic-beta flag.
  // Only claude-* models are touched — deepseek/minimax on the same endpoint accept both.
  it("drops task_budget but keeps context_management on OpenCode Go's Claude lane only", () => {
    const claude = {
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
      output_config: { effort: "high", task_budget: { type: "tokens", total: 5000 } },
    };
    stripUnsupportedParams("opencode-go", "claude-haiku-5-5", claude);
    // context editing is supported upstream when its beta flag travels along
    expect(claude.context_management).toEqual({ edits: [{ type: "clear_tool_uses_20250919" }] });
    // effort is what the upstream needs for adaptive thinking — it must survive
    expect(claude.output_config).toEqual({ effort: "high" });

    const other = {
      context_management: { edits: [] },
      output_config: { effort: "high", task_budget: { type: "tokens", total: 5000 } },
    };
    stripUnsupportedParams("opencode-go", "deepseek-v4-pro", other);
    expect(other.context_management).toEqual({ edits: [] });
    expect(other.output_config.task_budget).toBeDefined();

    // An output_config left empty is removed rather than sent as {}
    const empty = { output_config: { task_budget: { type: "tokens", total: 1 } } };
    stripUnsupportedParams("opencode-go", "claude-haiku-5-5", empty);
    expect(empty).not.toHaveProperty("output_config");

    // Other providers keep both fields untouched
    const foreign = { context_management: { edits: [] }, output_config: { effort: "high" } };
    stripUnsupportedParams("deepseek", "deepseek-v4-pro", foreign);
    expect(foreign.context_management).toEqual({ edits: [] });
    expect(foreign.output_config).toEqual({ effort: "high" });
  });

  it("renames max_tokens to max_completion_tokens for the openai provider", () => {
    const body = { max_tokens: 50, temperature: 1 };

    stripUnsupportedParams("openai", "gpt-6-luna", body);

    expect(body).toEqual({ max_completion_tokens: 50, temperature: 1 });
  });

  it("keeps an explicit max_completion_tokens when both are sent to openai", () => {
    const body = { max_tokens: 50, max_completion_tokens: 80 };

    stripUnsupportedParams("openai", "gpt-6-luna", body);

    expect(body).toEqual({ max_completion_tokens: 80 });
  });

  it("leaves max_tokens untouched for other providers", () => {
    const body = { max_tokens: 50 };

    stripUnsupportedParams("groq", "qwen/qwen3.6-27b", body);

    expect(body).toEqual({ max_tokens: 50 });
  });
});
