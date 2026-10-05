import { describe, expect, it } from "vitest";
import { GET } from "../../src/app/api/v1/models/route.js";

describe("GET /v1/models dual-envelope for Codex", () => {
  it("returns both standard OpenAI data and Codex models array", async () => {
    const response = await GET(new Request("http://localhost:20126/v1/models"));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.models.length).toBeGreaterThan(0);

    // Verify model entry schema expected by Codex
    const sample = body.models[0];
    expect(typeof sample.slug).toBe("string");
    expect(typeof sample.context_window).toBe("number");
    expect(typeof sample.max_context_window).toBe("number");
    expect(typeof sample.auto_compact_token_limit).toBe("number");
    expect(sample.auto_compact_token_limit).toBeLessThan(sample.max_context_window);

    // If luna-level is present, verify its context limits
    const luna = body.models.find((m) => m.slug === "luna-level");
    if (luna) {
      expect(luna.context_window).toBe(1048576);
      expect(luna.max_context_window).toBe(1048576);
      expect(luna.auto_compact_token_limit).toBe(786432);
    }
  });
});
