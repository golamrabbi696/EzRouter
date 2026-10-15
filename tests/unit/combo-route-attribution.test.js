import { describe, expect, it, beforeEach } from "vitest";
import { handleComboChat, resetAllModelCooldowns } from "../../open-sse/services/combo.js";
import * as routeAttribution from "../../open-sse/services/routeAttribution.js";

const log = { info() {}, warn() {} };

describe("Combo and Direct Route Attribution", () => {
  beforeEach(() => {
    resetAllModelCooldowns();
  });
  it("annotates a direct stream without exposing private identifiers", async () => {
    expect(typeof routeAttribution.annotateDirectResponse).toBe("function");
    let pulls = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("streamed data chunk"));
        controller.close();
      },
    });

    const response = routeAttribution.annotateDirectResponse({
      requestedModel: "gpt-4o-alias",
      resolvedModel: "openai/gpt-4o",
      connectionId: "must-not-leak",
      credentialId: "must-not-leak",
    }, new Response(body, {
      headers: { "Content-Type": "text/event-stream" },
    }));

    // Stream must not be pulled prematurely
    expect(pulls).toBe(0);
    expect(response.headers.get("x-model")).toBe("openai/gpt-4o");
    expect(response.headers.get("x-9router-model")).toBe("openai/gpt-4o");
    expect(response.headers.get("x-9router-requested-model")).toBe("gpt-4o-alias");
    expect(response.headers.get("x-9router-resolved-provider")).toBe("openai");
    expect(response.headers.get("x-9router-resolved-model")).toBe("gpt-4o");
    expect(response.headers.get("x-9router-route-path")).toBe("openai/gpt-4o");
    expect(response.headers.get("x-9router-fallback-count")).toBe("0");
    expect(response.headers.get("x-9router-attempted-models")).toBe("openai/gpt-4o");
    expect([...response.headers].some(([name, value]) => /credential|connection|must-not-leak/i.test(`${name}:${value}`))).toBe(false);
    expect(response.headers.get("access-control-expose-headers")).toContain("x-model");
    expect(response.headers.get("access-control-expose-headers")).toContain("x-9router-model");
    expect(response.headers.get("access-control-expose-headers")).toContain("X-9Router-Requested-Model");

    // Reading stream consumes it
    expect(await response.text()).toBe("streamed data chunk");
    expect(pulls).toBe(1);
  });

  it("reports the requested combo, resolved leaf, and attempted fallbacks", async () => {
    const attempts = [];
    const response = await handleComboChat({
      body: { model: "coding-combo", messages: [{ role: "user", content: "hello" }] },
      models: ["provider/model-a", "provider/model-b"],
      comboName: "coding-combo",
      comboStrategy: "fallback",
      log,
      handleSingleModel: async (_body, model) => {
        attempts.push(model);
        return model.endsWith("model-a")
          ? new Response("unavailable", { status: 503 })
          : new Response("ok", { headers: { "content-type": "text/plain" } });
      },
    });

    expect(await response.text()).toBe("ok");
    expect(attempts).toEqual(["provider/model-a", "provider/model-b"]);
    expect(response.headers.get("x-model")).toBe("provider/model-b");
    expect(response.headers.get("x-9router-model")).toBe("provider/model-b");
    expect(response.headers.get("x-9router-combo")).toBe("true");
    expect(response.headers.get("x-9router-requested-model")).toBe("coding-combo");
    expect(response.headers.get("x-9router-resolved-provider")).toBe("provider");
    expect(response.headers.get("x-9router-resolved-model")).toBe("model-b");
    expect(response.headers.get("x-9router-route-path")).toBe("coding-combo,provider/model-b");
    expect(response.headers.get("x-9router-fallback-count")).toBe("1");
    expect(response.headers.get("x-9router-attempted-models")).toBe("provider/model-a,provider/model-b");
  });

  it("handles multi-step fallbacks properly", async () => {
    const attempts = [];
    const response = await handleComboChat({
      body: { model: "three-tier-combo", messages: [{ role: "user", content: "test" }] },
      models: ["p1/m1", "p2/m2", "p3/m3"],
      comboName: "three-tier-combo",
      comboStrategy: "fallback",
      log,
      handleSingleModel: async (_body, model) => {
        attempts.push(model);
        if (model === "p1/m1") return new Response("502", { status: 502 });
        if (model === "p2/m2") return new Response("503", { status: 503 });
        return new Response("success", { headers: { "content-type": "application/json" } });
      },
    });

    expect(attempts).toEqual(["p1/m1", "p2/m2", "p3/m3"]);
    expect(response.headers.get("x-model")).toBe("p3/m3");
    expect(response.headers.get("x-9router-model")).toBe("p3/m3");
    expect(response.headers.get("x-9router-combo")).toBe("true");
    expect(response.headers.get("x-9router-fallback-count")).toBe("2");
    expect(response.headers.get("x-9router-attempted-models")).toBe("p1/m1,p2/m2,p3/m3");
    expect(response.headers.get("x-9router-route-path")).toBe("three-tier-combo,p3/m3");
  });

  it("preserves the complete nested combo path", async () => {
    const inner = () => handleComboChat({
      body: { model: "inner-combo", messages: [] },
      models: ["provider/model-a", "provider/model-b"],
      comboName: "inner-combo",
      comboStrategy: "fallback",
      log,
      handleSingleModel: async (_body, model) => model.endsWith("model-a")
        ? new Response("unavailable", { status: 503 })
        : new Response("ok"),
    });
    const response = await handleComboChat({
      body: { model: "outer-combo", messages: [] },
      models: ["inner-combo"],
      comboName: "outer-combo",
      comboStrategy: "fallback",
      log,
      handleSingleModel: inner,
    });

    expect(response.headers.get("x-model")).toBe("provider/model-b");
    expect(response.headers.get("x-9router-model")).toBe("provider/model-b");
    expect(response.headers.get("x-9router-combo")).toBe("true");
    expect(response.headers.get("x-9router-route-path")).toBe("outer-combo,inner-combo,provider/model-b");
    expect(response.headers.get("x-9router-resolved-provider")).toBe("provider");
    expect(response.headers.get("x-9router-resolved-model")).toBe("model-b");
    expect(response.headers.get("x-9router-fallback-count")).toBe("1");
    expect(response.headers.get("x-9router-attempted-models")).toBe("inner-combo,provider/model-a,provider/model-b");
  });

  it("annotates failed combo responses appropriately", async () => {
    const response = await handleComboChat({
      body: { model: "failing-combo", messages: [] },
      models: ["provider/fail-1", "provider/fail-2"],
      comboName: "failing-combo",
      comboStrategy: "fallback",
      log,
      handleSingleModel: async () => new Response("error", { status: 500 }),
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("x-model")).toBe("failed");
    expect(response.headers.get("x-9router-model")).toBe("failed");
    expect(response.headers.get("x-9router-combo")).toBe("true");
    expect(response.headers.get("x-9router-requested-model")).toBe("failing-combo");
    expect(response.headers.get("x-9router-fallback-count")).toBe("1");
    expect(response.headers.get("x-9router-attempted-models")).toBe("provider/fail-1,provider/fail-2");
  });

  it("formats headers across different input model formats without throwing", () => {
    const testCases = [
      { req: "medium", res: "openai/gpt-4o", expProvider: "openai", expModel: "gpt-4o" },
      { req: "anthropic/claude-3-7-sonnet", res: "anthropic/claude-3-7-sonnet", expProvider: "anthropic", expModel: "claude-3-7-sonnet" },
      { req: "custom-local", res: "ollama/llama3", expProvider: "ollama", expModel: "llama3" },
      { req: "gemini", res: "gemini-2.5-pro", expProvider: "unknown", expModel: "gemini-2.5-pro" },
    ];

    for (const { req, res, expProvider, expModel } of testCases) {
      const resp = routeAttribution.annotateDirectResponse({
        requestedModel: req,
        resolvedModel: res,
      }, new Response("body"));

      expect(resp.headers.get("x-model")).toBe(res);
      expect(resp.headers.get("x-9router-model")).toBe(res);
      expect(resp.headers.get("x-9router-resolved-provider")).toBe(expProvider);
      expect(resp.headers.get("x-9router-resolved-model")).toBe(expModel);
    }
  });
});
