import { describe, expect, it } from "vitest";
import { resolveTransport } from "../../open-sse/services/provider.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { translateRequest } from "../../open-sse/translator/index.js";

describe("multi-endpoint model transport", () => {
  it("routes OpenAI chat clients of Responses-only Muse models to /responses", () => {
    const transport = resolveTransport("muse", "openai", "openai-responses", ["openai-responses"]);
    expect(transport.format).toBe("openai-responses");
    expect(new DefaultExecutor("muse").buildUrl("muse-spark-1.3", true, 0, { runtimeTransport: transport })).toBe("https://api.meta.ai/v1/responses");
    const body = translateRequest("openai", transport.format, "muse-spark-1.3", { messages: [{ role: "user", content: "hi" }] }, true, null, "muse");
    expect(body.input).toHaveLength(1);
    expect(body).not.toHaveProperty("messages");
  });

  it("keeps the source endpoint for models that support it", () => {
    const transport = resolveTransport("muse", "openai", "openai-responses", ["openai", "openai-responses"]);
    expect(transport.format).toBe("openai");
  });
});
