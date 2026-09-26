import { describe, it, expect } from "vitest";
import {
  openaiResponsesToOpenAIRequest,
  openaiToOpenAIResponsesRequest,
} from "../../open-sse/translator/request/openai-responses.js";

const schema = {
  type: "object",
  properties: { title: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
  required: ["title"],
  additionalProperties: false,
};
const messages = [{ role: "user", content: "Extract the title" }];

describe("structured output across Responses and Chat Completions", () => {
  it("Responses text.format json_schema becomes Chat response_format and text is not leaked", () => {
    const out = openaiResponsesToOpenAIRequest("m", {
      model: "m",
      input: "extract",
      text: { format: { type: "json_schema", name: "doc", strict: true, schema } },
    }, false);
    expect(out.response_format).toEqual({ type: "json_schema", json_schema: { name: "doc", schema, strict: true } });
    expect(out.text).toBeUndefined();
  });

  it("Responses text.format json_object becomes response_format json_object", () => {
    const out = openaiResponsesToOpenAIRequest("m", { model: "m", input: "x", text: { format: { type: "json_object" } } }, false);
    expect(out.response_format).toEqual({ type: "json_object" });
  });

  it("Chat response_format json_schema becomes Responses text.format", () => {
    const out = openaiToOpenAIResponsesRequest("m", {
      messages,
      response_format: { type: "json_schema", json_schema: { name: "doc", schema, strict: true } },
    }, true);
    expect(out.text.format).toEqual({ type: "json_schema", name: "doc", schema, strict: true });
  });
});
