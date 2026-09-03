import { describe, expect, it } from "vitest";
import { GET as handleOAuthGet, POST as handleOAuthPost } from "@/app/api/oauth/[provider]/[action]/route";
import { POST as handleCallback } from "@/app/api/oauth/callback/route";
import { getOAuthSessionStatus } from "@/lib/oauth/utils/server";

describe("Full OAuth End-to-End Flow", () => {
  it("runs authorize -> poll -> callback -> poll successfully", async () => {
    // 1. Authorize
    const authReq = new Request("http://localhost:20126/api/oauth/antigravity/authorize?redirect_uri=http://localhost:20126/callback");
    const authRes = await handleOAuthGet(authReq, { params: Promise.resolve({ provider: "antigravity", action: "authorize" }) });
    const authData = await authRes.json();
    expect(authRes.status).toBe(200);
    expect(authData.state).toBeDefined();

    // 2. Poll initial status
    const pollReq1 = new Request("http://localhost:20126/api/oauth/antigravity/poll-status?state=" + encodeURIComponent(authData.state));
    const pollRes1 = await handleOAuthGet(pollReq1, { params: Promise.resolve({ provider: "antigravity", action: "poll-status" }) });
    const pollData1 = await pollRes1.json();
    expect(pollData1.status).toBe("pending");

    // 3. Callback (with invalid code to see error status)
    const cbReq = new Request("http://localhost:20126/api/oauth/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: authData.state, code: "fake_google_code" })
    });
    const cbRes = await handleCallback(cbReq);
    expect(cbRes.status).toBe(500);

    // 4. Poll after error
    const pollReq2 = new Request("http://localhost:20126/api/oauth/antigravity/poll-status?state=" + encodeURIComponent(authData.state));
    const pollRes2 = await handleOAuthGet(pollReq2, { params: Promise.resolve({ provider: "antigravity", action: "poll-status" }) });
    const pollData2 = await pollRes2.json();
    console.log("Poll status after callback error:", pollData2);
    expect(pollData2.status).toBe("error");
    expect(pollData2.error).toContain("Token exchange failed");
  });
});
