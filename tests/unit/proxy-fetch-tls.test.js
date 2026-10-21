// Outbound TLS verification in proxyAwareFetch (open-sse/utils/proxyFetch.js).
//
// A real HTTPS server on 127.0.0.1 with a throwaway self-signed certificate
// stands in for a host the gateway does not trust (an attacker on the path, or a
// TLS-intercepting proxy whose root CA is not installed).
//
// - Default: the call fails closed and the server never sees the request, so the
//   provider key in its headers / query is never sent.
// - ALLOW_INSECURE_TLS_FALLBACK=true: the previous retry without verification is
//   back, for TLS-intercepting corporate / antivirus proxies.
// - STRICT_SSL=true always wins.
// - The warning logs the origin only, never the path or a ?key= query.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import https from "node:https";
import selfsigned from "selfsigned";

// proxyFetch.js patches globalThis.fetch on import and keeps the original; give
// every fresh import the real fetch, not a previous import's patched one.
const realFetch = globalThis.fetch;
const KEY = "test-provider-key-0000";

let server;
let origin;
const seen = [];

beforeAll(async () => {
  const pems = await selfsigned.generate([{ name: "commonName", value: "127.0.0.1" }], {
    keySize: 2048,
    algorithm: "sha256",
    extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }],
  });
  server = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    seen.push({ url: req.url, key: req.headers["x-goog-api-key"] });
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `https://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  seen.length = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
});

async function load(env = {}) {
  vi.resetModules();
  globalThis.fetch = realFetch;
  for (const name of ["ALLOW_INSECURE_TLS_FALLBACK", "STRICT_SSL", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    vi.stubEnv(name, env[name] ?? "");
  }
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const mod = await import("../../open-sse/utils/proxyFetch.js");
  return { proxyAwareFetch: mod.proxyAwareFetch, warn };
}

const providerCall = (proxyAwareFetch) => proxyAwareFetch(
  `${origin}/v1beta/models/m:generateContent?key=${KEY}`,
  { method: "POST", headers: { "x-goog-api-key": KEY, "content-type": "application/json" }, body: "{}" },
);
const warnings = (warn) => warn.mock.calls.map((args) => args.join(" ")).join("\n");

describe("proxyAwareFetch TLS certificate errors", () => {
  it("fails closed by default: the server never receives the request or the key", async () => {
    const { proxyAwareFetch, warn } = await load();
    const err = await providerCall(proxyAwareFetch).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.cause?.code || err.code).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
    expect(seen).toEqual([]);
    const logged = warnings(warn);
    expect(logged).toContain("not retrying without verification");
    expect(logged).toContain(origin);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain("key=");
  });

  it("ALLOW_INSECURE_TLS_FALLBACK=true opts in to the insecure retry (previous behaviour)", async () => {
    const { proxyAwareFetch, warn } = await load({ ALLOW_INSECURE_TLS_FALLBACK: "true" });
    const res = await providerCall(proxyAwareFetch);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen).toEqual([{ url: `/v1beta/models/m:generateContent?key=${KEY}`, key: KEY }]);
    const logged = warnings(warn);
    expect(logged).toContain("retrying with insecure TLS");
    expect(logged).toContain(origin);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain("/v1beta");
  });

  it("accepts 1 as true", async () => {
    const { proxyAwareFetch } = await load({ ALLOW_INSECURE_TLS_FALLBACK: "1" });
    expect((await providerCall(proxyAwareFetch)).status).toBe(200);
  });

  it("any other value keeps verification on", async () => {
    for (const value of ["yes", "on", "false", "0"]) {
      const { proxyAwareFetch } = await load({ ALLOW_INSECURE_TLS_FALLBACK: value });
      await expect(providerCall(proxyAwareFetch)).rejects.toThrow();
    }
    expect(seen).toEqual([]);
  });

  it("STRICT_SSL=true wins over the opt-in", async () => {
    const { proxyAwareFetch } = await load({ ALLOW_INSECURE_TLS_FALLBACK: "true", STRICT_SSL: "true" });
    await expect(providerCall(proxyAwareFetch)).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it("non-certificate errors are rethrown untouched, with no TLS warning", async () => {
    const { proxyAwareFetch, warn } = await load({ ALLOW_INSECURE_TLS_FALLBACK: "true" });
    // Plain HTTP against the TLS port: a protocol error, not a certificate error.
    await expect(proxyAwareFetch(`${origin.replace("https:", "http:")}/x`)).rejects.toThrow();
    expect(warnings(warn)).not.toContain("TLS cert verification failed");
  });
});
