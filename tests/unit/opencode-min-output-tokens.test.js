import { describe, expect, it } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { OpenCodeZenExecutor } from "../../open-sse/executors/opencode-zen.js";

// Console rejects max_output_tokens < 16 with 400 invalid_request_error, so a
// tiny model-switch probe (Claude Code checks a model with max_tokens: 1)
// made the client refuse to switch models. Both executors floor the cap.
const MODEL = "muse-spark-1.3-contributor-free";
const CREDS = { connectionId: "opencode-min-output-tokens-test" };
const INPUT = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];

function chatBody(cap) {
  return { model: MODEL, input: structuredClone(INPUT), ...cap };
}

describe.each([
  ["opencode", () => new OpenCodeExecutor()],
  ["opencode-zen", () => new OpenCodeZenExecutor()],
])("%s floors tiny output caps at the provider minimum", (_name, make) => {
  it("clamps max_tokens: 1 up to 16", () => {
    const out = make().transformRequest(MODEL, chatBody({ max_tokens: 1 }), true, CREDS);
    expect(out.max_output_tokens).toBe(16);
    expect(out.max_tokens).toBeUndefined();
    expect(out.max_completion_tokens).toBeUndefined();
  });

  it("clamps max_completion_tokens: 5 up to 16", () => {
    const out = make().transformRequest(MODEL, chatBody({ max_completion_tokens: 5 }), true, CREDS);
    expect(out.max_output_tokens).toBe(16);
  });

  it("leaves normal caps untouched", () => {
    const out = make().transformRequest(MODEL, chatBody({ max_tokens: 4096 }), true, CREDS);
    expect(out.max_output_tokens).toBe(4096);
  });
});
