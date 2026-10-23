import { describe, expect, it } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";

const credentials = { connectionId: "fixture", accessToken: "fixture-token" };
const user = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const assistant = (text) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });

describe("Codex input from a conversation that also ran on Grok Build", () => {
  it.each(["gpt-6.1-sol", "gpt-5.5"])("drops Grok-encrypted reasoning items for %s", (model) => {
    const grokReasoning = {
      type: "reasoning",
      id: "rs_aca4e4a2-50fa-9d40-a12a-cb7e1f0d2c3b",
      summary: [],
      encrypted_content: "grok-ciphertext",
    };
    const openaiReasoning = {
      type: "reasoning",
      id: "rs_68c0f1e2a3b4c5d6e7f8091a2b3c4d5e",
      summary: [],
      encrypted_content: "openai-ciphertext",
    };
    const body = new CodexExecutor().transformRequest(model, {
      model,
      input: [user("first"), grokReasoning, assistant("from grok"), openaiReasoning, assistant("from codex"), user("next")],
    }, true, credentials);

    const reasoning = body.input.filter((item) => item.type === "reasoning");
    expect(reasoning.map((item) => item.encrypted_content)).toEqual(["openai-ciphertext"]);
    expect(body.input.filter((item) => item.type === "message").map((m) => m.content[0].text))
      .toEqual(expect.arrayContaining(["first", "from grok", "from codex", "next"]));
  });
});
