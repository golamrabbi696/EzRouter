import { describe, expect, it } from "vitest";

import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// claude-haiku-5-5 has no exact entry and matched only the generic *claude*haiku*
// pattern (claude-budget). On OpenCode Go's /messages endpoint that sends
// thinking.type "enabled" and the upstream answers 400: "thinking.type.enabled is not
// supported for this model. Use thinking.type.adaptive and output_config.effort".
// Like the 5.x Sonnet/Opus family it must resolve to adaptive — but only for this
// provider, because claude-budget is still correct for older Haiku builds and for
// every other provider.
describe("Claude Haiku 5.5 capabilities", () => {
  it("resolves to adaptive thinking on OpenCode Go", () => {
    for (const model of ["claude-haiku-5-5", "ocg/claude-haiku-5-5"]) {
      expect(getCapabilitiesForModel("opencode-go", model)).toMatchObject({
        thinkingFormat: "claude-adaptive",
        reasoning: true,
        vision: true,
        // limits follow catalog values pinned in capabilities.js
        contextWindow: 1000000,
        maxOutput: 128000,
      });
    }
  });

  it("leaves older Haiku builds on claude-budget", () => {
    expect(getCapabilitiesForModel("opencode-go", "claude-haiku-4-5").thinkingFormat).toBe("claude-budget");
  });

  it("does not leak adaptive thinking to other providers", () => {
    expect(getCapabilitiesForModel("claude", "claude-haiku-5-5").thinkingFormat).toBe("claude-budget");
    expect(getCapabilitiesForModel("deepseek", "claude-haiku-5-5").thinkingFormat).toBe("claude-budget");
  });
});
