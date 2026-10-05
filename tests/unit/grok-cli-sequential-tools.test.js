import { describe, expect, it } from "vitest";
import { GrokCliExecutor } from "../../open-sse/executors/grok-cli.js";

function transform(tools, parallel_tool_calls = true) {
  return new GrokCliExecutor().transformRequest("grok-4", {
    model: "grok-4",
    input: [{ role: "user", content: "Run shell steps in order" }],
    tools,
    parallel_tool_calls,
    tool_choice: "auto",
  }, true, { connectionId: "sequential-tools-test" });
}

describe("Grok CLI sequential tool requests", () => {
  it.each([true, false, undefined])("disables parallel calls for function tools (client value %s)", (parallel) => {
    const body = transform([{ type: "function", function: { name: "shell", parameters: { type: "object", properties: {} } } }], parallel);
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.tools[0]).toMatchObject({ type: "function", name: "shell" });
  });

  it("keeps hosted tools while disabling parallel calls", () => {
    const body = transform([{ type: "web_search" }]);
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(body.parallel_tool_calls).toBe(false);
  });

  it("removes parallel calls when all tools are rejected", () => {
    const body = transform([{ type: "unsupported" }, null]);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("parallel_tool_calls");
  });

  it.each([undefined, []])("removes parallel calls when tools are absent or empty", (tools) => {
    const body = transform(tools);
    expect(body).not.toHaveProperty("parallel_tool_calls");
  });
});
