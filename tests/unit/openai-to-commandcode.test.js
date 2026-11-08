/**
 * Unit tests for open-sse/translator/request/openai-to-commandcode.js
 *
 * Verified live against upstream `/alpha/generate` (curl, 2026-05-07):
 *  - params.system: STRING at top level (Anthropic-style; "system" role NOT in messages[])
 *  - params.messages[*].role ∈ {"user","assistant","tool"}
 *  - params.messages[*].content: Array<content_block> (NEVER string)
 *  - tools[*]: Anthropic plain {name, description, input_schema}
 */

import { describe, it, expect } from "vitest";
import { openaiToCommandCodeRequest } from "../../open-sse/translator/request/openai-to-commandcode.js";

const MODEL = "moonshotai/Kimi-K2.6";

describe("openaiToCommandCodeRequest — basic envelope", () => {
  it("returns the expected top-level envelope shape", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [{ role: "user", content: "hi" }],
    }, true);

    expect(out).toHaveProperty("threadId");
    expect(out).toHaveProperty("memory");
    expect(out).toHaveProperty("config");
    expect(out).toHaveProperty("params");
    expect(out.params.model).toBe(MODEL);
    expect(out.params.stream).toBe(true);
  });
});

describe("openaiToCommandCodeRequest — thinking suffix stripping", () => {
  it("strips a client thinking suffix from params.model (upstream rejects it)", () => {
    const out = openaiToCommandCodeRequest("gpt-5.6-luna(max)", {
      messages: [{ role: "user", content: "hi" }],
    }, true);

    expect(out.params.model).toBe("gpt-5.6-luna");
  });

  it("strips the suffix from family-prefixed ids too", () => {
    const out = openaiToCommandCodeRequest("deepseek/deepseek-v4-pro(max)", {
      messages: [{ role: "user", content: "hi" }],
    }, true);

    expect(out.params.model).toBe("deepseek/deepseek-v4-pro");
  });

  it("leaves plain model ids untouched", () => {
    const out = openaiToCommandCodeRequest("deepseek/deepseek-v4-pro", {
      messages: [{ role: "user", content: "hi" }],
    }, true);

    expect(out.params.model).toBe("deepseek/deepseek-v4-pro");
  });
});

describe("openaiToCommandCodeRequest — system handling", () => {
  it("hoists system messages to params.system (string), not messages[]", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [
        { role: "system", content: "You are concise." },
        { role: "user", content: "hi" },
      ],
    }, true);

    expect(typeof out.params.system).toBe("string");
    expect(out.params.system).toBe("You are concise.");
    const roles = out.params.messages.map((m) => m.role);
    expect(roles).not.toContain("system");
  });

  it("joins multiple system messages with blank line", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [
        { role: "system", content: "A" },
        { role: "system", content: "B" },
        { role: "user", content: "hi" },
      ],
    }, true);

    expect(out.params.system).toBe("A\n\nB");
  });

  it("omits params.system when no system messages", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [{ role: "user", content: "hi" }],
    }, true);
    expect(out.params.system).toBeUndefined();
  });
});

describe("openaiToCommandCodeRequest — content shape", () => {
  it("MUST always emit content as Array (never string) for user", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [{ role: "user", content: "hello" }],
    }, true);

    const u = out.params.messages[0];
    expect(Array.isArray(u.content)).toBe(true);
    expect(u.content[0]).toEqual({ type: "text", text: "hello" });
  });

  it("MUST always emit content as Array for assistant", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ],
    }, true);
    const a = out.params.messages[1];
    expect(Array.isArray(a.content)).toBe(true);
    expect(a.content[0]).toEqual({ type: "text", text: "b" });
  });
});

describe("openaiToCommandCodeRequest — tool role / tool-result (AI SDK)", () => {
  it("converts role:\"tool\" to role:\"tool\" with tool-result block; output is {type:\"text\",value}", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [
        { role: "user", content: "run X" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "do_x", arguments: "{\"a\":1}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", name: "do_x", content: "RESULT_OK" },
      ],
    }, true);

    const toolMsg = out.params.messages[out.params.messages.length - 1];
    expect(toolMsg.role).toBe("tool");
    const block = toolMsg.content[0];
    expect(block.type).toBe("tool-result");
    expect(block.toolCallId).toBe("call_1");
    expect(block.toolName).toBe("do_x");
    expect(block.output).toEqual({ type: "text", value: "RESULT_OK" });
  });

  it("resolves toolName from prior assistant tool_calls when name is omitted (Claude Code & OpenAI SDK standard)", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [
        { role: "user", content: "read file" },
        {
          role: "assistant",
          content: "Let me check",
          tool_calls: [
            { id: "toolu_read_1", type: "function", function: { name: "Read", arguments: "{\"path\":\"a.txt\"}" } },
          ],
        },
        // Real-world Claude Code / OpenAI client turn: tool name is NOT sent on role: "tool"
        { role: "tool", tool_call_id: "toolu_read_1", content: "FILE_CONTENT" },
      ],
    }, true);

    const toolMsg = out.params.messages[out.params.messages.length - 1];
    expect(toolMsg.role).toBe("tool");
    const block = toolMsg.content[0];
    expect(block.toolCallId).toBe("toolu_read_1");
    expect(block.toolName).toBe("Read");
    expect(block.output).toEqual({ type: "text", value: "FILE_CONTENT" });
  });

  it("emits error-text output type when is_error is true", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [
        { role: "user", content: "run command" },
        {
          role: "assistant",
          tool_calls: [
            { id: "call_bash_1", type: "function", function: { name: "Bash", arguments: "{\"command\":\"exit 1\"}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_bash_1", content: "Command failed: exit 1", is_error: true },
      ],
    }, true);

    const toolMsg = out.params.messages[out.params.messages.length - 1];
    const block = toolMsg.content[0];
    expect(block.toolName).toBe("Bash");
    expect(block.output).toEqual({ type: "error-text", value: "Command failed: exit 1" });
  });
});

describe("openaiToCommandCodeRequest — assistant reasoning handling", () => {
  it("does not inject empty reasoning block when assistant has tool_calls but no reasoning", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "I will call a tool",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "test", arguments: "{}" } },
          ],
        },
      ],
    }, true);

    const asst = out.params.messages[1];
    const reasoning = asst.content.find((b) => b.type === "reasoning");
    expect(reasoning).toBeUndefined();
  });

  it("preserves actual reasoning_content when present", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [
        { role: "user", content: "think" },
        {
          role: "assistant",
          reasoning_content: "Step 1: analyze problem",
          content: "Here is the answer",
        },
      ],
    }, true);

    const asst = out.params.messages[1];
    const reasoning = asst.content.find((b) => b.type === "reasoning");
    expect(reasoning).toBeDefined();
    expect(reasoning.text).toBe("Step 1: analyze problem");
  });
});

describe("openaiToCommandCodeRequest — defaults & envelope", () => {
  it("defaults max_tokens to 64000 matching official CLI", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [{ role: "user", content: "hi" }],
    }, true);

    expect(out.params.max_tokens).toBe(64000);
    expect(out.memory).toBeNull();
    expect(out.taste).toBeNull();
    expect(out.skills).toBeNull();
    expect(out.permissionMode).toBe("standard");
  });

  it("preserves client max_tokens when specified", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 16384,
    }, true);

    expect(out.params.max_tokens).toBe(16384);
  });

  it("forwards reasoning_effort inside params", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
    }, true);

    expect(out.params.reasoning_effort).toBe("high");
  });

  it("extracts effort from Claude output_config.effort", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "max" },
    }, true);

    expect(out.params.reasoning_effort).toBe("max");
  });
});

describe("openaiToCommandCodeRequest — assistant tool_calls / tool-call", () => {
  it("converts assistant.tool_calls[] into content blocks of type tool-call", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_42", type: "function", function: { name: "search", arguments: "{\"q\":\"hi\"}" } },
          ],
        },
      ],
    }, true);

    const asst = out.params.messages[1];
    expect(asst.role).toBe("assistant");
    const tc = asst.content.find((b) => b.type === "tool-call");
    expect(tc).toBeDefined();
    expect(tc.toolCallId).toBe("call_42");
    expect(tc.toolName).toBe("search");
    expect(tc.input).toEqual({ q: "hi" });
  });
});

describe("openaiToCommandCodeRequest — tools schema conversion", () => {
  it("converts OpenAI {type:\"function\", function:{...}} to Anthropic plain {name, input_schema}", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            description: "Get weather",
            parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
          },
        },
      ],
    }, true);

    const t = out.params.tools[0];
    expect(t.name).toBe("weather");
    expect(t.input_schema).toBeDefined();
    expect(t.input_schema.type).toBe("object");
    expect(t.function).toBeUndefined();
    expect(t.parameters).toBeUndefined();
  });

  it("preserves description on converted tool", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "ping", description: "Ping the server", parameters: { type: "object" } } },
      ],
    }, true);
    expect(out.params.tools[0].description).toBe("Ping the server");
  });

  it("preserves image_url as an image content block", () => {
    const out = openaiToCommandCodeRequest("deepseek/deepseek-v4-flash-vision-exp", {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
        ],
      }],
    }, true);
    const blocks = out.params.messages[0].content;
    expect(blocks).toContainEqual({ type: "text", text: "look" });
    expect(blocks).toContainEqual({
      type: "image",
      image: "data:image/png;base64,BBBB",
      mediaType: "image/png",
      mimeType: "image/png",
    });
  });

  it("does not include tools field when input has none", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [{ role: "user", content: "hi" }],
    }, true);
    expect(out.params.tools).toBeUndefined();
  });
});

describe("openaiToCommandCodeRequest — token limits", () => {
  it("clamps max_tokens to 200000 when client requests oversized max_output_tokens", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [{ role: "user", content: "hi" }],
      max_output_tokens: 384000,
    }, true);
    expect(out.params.max_tokens).toBe(200000);
  });

  it("clamps max_tokens to 200000 when client requests oversized max_tokens", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1000000,
    }, true);
    expect(out.params.max_tokens).toBe(200000);
  });

  it("preserves max_tokens within upstream 200000 limit", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8192,
    }, true);
    expect(out.params.max_tokens).toBe(8192);
  });
});
