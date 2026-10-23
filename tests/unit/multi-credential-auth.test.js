// Multi-credential client auth and per-key access control following the
// multi-credential identity.
//
// One DB fixture backs all three readers — the middleware (dashboardGuard), the
// handlers' resolveClientApiKey and the key-access engine — so the exhaustive
// matrix below proves they agree on every combination of credentials, and that
// no combination makes a restricted key run unrestricted or an invalid key pass.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fx = vi.hoisted(() => ({
  combos: [{ id: "c1", name: "Main", models: ["openai/model-a", "openai/model-b"] }],
  keys: {},
  settings: { requireApiKey: true, requireLogin: true, comboStrategy: "fallback" },
}));
const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  handleChatCore: vi.fn(),
  handleEmbeddingsCore: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => ({ status: 200, next: true })),
    json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: async () => "cli-token-fixture" }));
vi.mock("@/lib/auth/dashboardSession", () => ({ verifyDashboardAuthToken: async () => false }));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => fx.settings,
  validateApiKey: async (k) => fx.keys[k]?.isActive === true,
  getApiKeyByValue: async (k) => fx.keys[k] || null,
  getModelAliases: async () => ({}),
  getComboByName: async (name) => fx.combos.find((c) => c.name === name) || null,
  getProviderNodes: async () => [],
  getCombos: async () => fx.combos,
  getProviderConnections: async () => [],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
  updateProviderConnection: async () => {},
  getProxyPools: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => fx.combos }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async (k) => fx.keys[k] || null }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/services/auth.js", async (importOriginal) => ({
  ...(await importOriginal()), // real extractApiKeyCandidates / resolveClientApiKey
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("open-sse/handlers/embeddingsCore.js", () => ({ handleEmbeddingsCore: mocks.handleEmbeddingsCore }));

const { extractApiKeyCandidates } = await import("../../src/shared/utils/apiKeyCandidates.js");
const { proxy } = await import("../../src/dashboardGuard.js");
const auth = await import("../../src/sse/services/auth.js");
const engine = await import("../../src/sse/services/keyAccess.js");
const { handleChat } = await import("../../src/sse/handlers/chat.js");
const { handleEmbeddings } = await import("../../src/sse/handlers/embeddings.js");

// ── fixture keys ─────────────────────────────────────────────────────────────
const KEYS = {
  junk: null, // not in the DB
  U: { isActive: true, access: { restricted: false, allow: [] } },
  rA: { isActive: true, access: { restricted: true, allow: ["openai/model-a"] } },
  rB: { isActive: true, access: { restricted: true, allow: ["openai/model-b"] } },
  rE: { isActive: true, access: { restricted: true, allow: [] } },
  inU: { isActive: false, access: { restricted: false, allow: [] } },
  inR: { isActive: false, access: { restricted: true, allow: ["openai/model-a", "openai/model-b"] } },
};
const sk = (name) => `sk-${name}`;

beforeEach(() => {
  vi.clearAllMocks();
  fx.settings = { requireApiKey: true, requireLogin: true, comboStrategy: "fallback" };
  fx.keys = {};
  for (const [name, rec] of Object.entries(KEYS)) {
    if (rec) fx.keys[sk(name)] = { id: name, name: `key-${name}`, ...rec };
  }
  mocks.getProviderCredentials.mockResolvedValue({ connectionId: "conn", connectionName: "mock" });
  mocks.handleChatCore.mockImplementation(async () => ({
    success: true,
    response: new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n", {
      status: 200, headers: { "Content-Type": "text/event-stream" },
    }),
  }));
  mocks.handleEmbeddingsCore.mockResolvedValue({ success: true, response: Response.json({ data: [] }) });
});

// A remote request (no loopback peer proof), as the middleware sees it in production.
function nextRequest(path, headers) {
  const url = `http://router.example.com${path}`;
  return {
    nextUrl: { pathname: new URL(url).pathname, searchParams: new URL(url).searchParams },
    headers: new Headers({ host: "router.example.com", ...headers }),
    cookies: { get: () => undefined },
    url,
  };
}
function build({ bearer, xApiKey, goog, query, path = "/v1/chat/completions", rawAuth } = {}) {
  const headers = {};
  if (rawAuth !== undefined) headers.Authorization = rawAuth;
  else if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (xApiKey) headers["x-api-key"] = xApiKey;
  if (goog) headers["x-goog-api-key"] = goog;
  const p = query ? `${path}?key=${encodeURIComponent(query)}` : path;
  return { path: p, headers };
}
const webRequest = ({ path, headers }, body) => new Request(`http://router.example.com${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: body ? JSON.stringify(body) : undefined,
});

async function guardAccepts(spec) {
  const r = await proxy(nextRequest(spec.path, spec.headers));
  return r.status === 200;
}
async function effectiveAccess(spec) {
  const ctx = await engine.getKeyAccessContext(webRequest(spec));
  const can = async (m) => (await engine.enforceKeyAccess(ctx, m)) === null;
  return { restricted: ctx !== null, a: await can("openai/model-a"), b: await can("openai/model-b") };
}

// ── the shared candidate reader ─────────────────────────────────────────────
describe("extractApiKeyCandidates (shared by middleware, handlers and key access)", () => {
  const cands = (spec) => extractApiKeyCandidates(webRequest(spec));
  it("collects every presented credential in precedence order", () => {
    expect(cands(build({ bearer: "b", xApiKey: "x", goog: "g", query: "q" }))).toEqual(["b", "x", "g", "q"]);
  });
  it("reads the query key from nextUrl (middleware) and from url (route handlers) alike", () => {
    const spec = build({ query: "q" });
    expect(extractApiKeyCandidates(nextRequest(spec.path, spec.headers))).toEqual(["q"]);
    expect(cands(spec)).toEqual(["q"]);
  });
  it("collapses duplicates and skips empty values", () => {
    expect(cands(build({ bearer: "k", xApiKey: "k", goog: "k", query: "k" }))).toEqual(["k"]);
    expect(cands(build({ xApiKey: "", goog: "" }))).toEqual([]);
  });
  it("an empty Bearer is not a candidate", () => {
    expect(cands(build({ rawAuth: "Bearer " }))).toEqual([]);
    expect(cands(build({ rawAuth: "Bearer" }))).toEqual([]);
  });
  it("only the exact 'Bearer ' scheme is read (unchanged from before)", () => {
    expect(cands(build({ rawAuth: "bearer sk-U" }))).toEqual([]);
    expect(cands(build({ rawAuth: "BEARER sk-U" }))).toEqual([]);
    expect(cands(build({ rawAuth: "Basic c2stVQ==" }))).toEqual([]);
    expect(cands(build({ rawAuth: "sk-U" }))).toEqual([]);
  });
  it("values are not trimmed or rewritten (a padded key is a different string)", () => {
    expect(cands(build({ rawAuth: "Bearer  sk-U" }))).toEqual([" sk-U"]);
  });
  it("a duplicated header arrives combined and is a single (non-matching) candidate", () => {
    const req = new Request("http://router.example.com/v1/chat/completions", {
      method: "POST", headers: [["x-api-key", "sk-rA"], ["x-api-key", "sk-U"]],
    });
    expect(extractApiKeyCandidates(req)).toEqual(["sk-rA, sk-U"]);
  });
  it("a repeated ?key= yields only its first value", () => {
    const req = new Request("http://router.example.com/v1/chat/completions?key=sk-rA&key=sk-U");
    expect(extractApiKeyCandidates(req)).toEqual(["sk-rA"]);
  });
  it("tolerates requests without headers", () => {
    expect(extractApiKeyCandidates(null)).toEqual([]);
    expect(extractApiKeyCandidates({})).toEqual([]);
  });
});

// ── exhaustive matrix: every slot × every key kind ──────────────────────────
// Oracle, written independently of the implementation:
//   valid    = presented values that are known AND active keys
//   accepted = valid is non-empty (middleware, and handlers with requireApiKey)
//   access   = none valid → unrestricted; any valid unrestricted → unrestricted;
//              else the union of the valid keys' allow lists.
const KINDS = [null, ...Object.keys(KEYS)];
function oracle(values) {
  const presented = [...new Set(values.filter(Boolean).map(sk))];
  const valid = presented.map((k) => fx.keys[k]).filter((r) => r?.isActive === true);
  if (valid.length === 0) return { accepted: false, restricted: false, a: true, b: true, attributed: presented[0] || null };
  const attributed = presented.find((k) => fx.keys[k]?.isActive === true);
  if (valid.some((r) => !r.access.restricted)) return { accepted: true, restricted: false, a: true, b: true, attributed };
  const allow = new Set(valid.flatMap((r) => r.access.allow));
  return { accepted: true, restricted: true, a: allow.has("openai/model-a"), b: allow.has("openai/model-b"), attributed };
}
const combos = [];
for (const b of KINDS) for (const x of KINDS) for (const g of KINDS) for (const q of KINDS) combos.push([b, x, g, q]);

describe("exhaustive credential matrix (Bearer × x-api-key × x-goog-api-key × ?key=)", () => {
  it(`middleware, resolveClientApiKey and key access all match the oracle on ${combos.length} combinations`, async () => {
    const mismatches = [];
    for (const [b, x, g, q] of combos) {
      const spec = build({ bearer: b && sk(b), xApiKey: x && sk(x), goog: g && sk(g), query: q && sk(q) });
      const want = oracle([b, x, g, q]);
      const accepted = await guardAccepts(spec);
      const resolved = await auth.resolveClientApiKey(webRequest(spec));
      const access = await effectiveAccess(spec);
      const got = { accepted, resolvedValid: resolved.valid, attributed: resolved.apiKey, ...access };
      const exp = { accepted: want.accepted, resolvedValid: want.accepted, attributed: want.attributed, restricted: want.restricted, a: want.a, b: want.b };
      if (JSON.stringify(got) !== JSON.stringify(exp)) mismatches.push({ slots: [b, x, g, q], got, exp });
    }
    expect(mismatches).toEqual([]);
  }, 60000);

  it("the matrix covers the Claude Code shape and the privilege-sensitive cases", () => {
    const has = (slots) => combos.some((c) => JSON.stringify(c) === JSON.stringify(slots));
    expect(has(["junk", "rA", null, null])).toBe(true); // Claude Code: foreign Bearer + restricted x-api-key
    expect(has(["inU", "rA", null, null])).toBe(true); // inactive unrestricted must not unlock
    expect(has(["rA", "rB", null, null])).toBe(true); // union
  });
});

// ── named cases (readable evidence for the PR) ──────────────────────────────
describe("access follows the multi-credential identity", () => {
  const access = (slots) => effectiveAccess(build(slots));
  it("junk Bearer + restricted x-api-key → restricted (a first-key rule would run it unrestricted)", async () => {
    expect(await access({ bearer: "sk-junk", xApiKey: "sk-rA" })).toEqual({ restricted: true, a: true, b: false });
  });
  it("junk Bearer + unrestricted x-api-key → unrestricted", async () => {
    expect(await access({ bearer: "sk-junk", xApiKey: "sk-U" })).toEqual({ restricted: false, a: true, b: true });
  });
  it("two restricted keys → the union of their lists", async () => {
    expect(await access({ bearer: "sk-rA", xApiKey: "sk-rB" })).toEqual({ restricted: true, a: true, b: true });
    expect(await access({ xApiKey: "sk-rE", goog: "sk-rB" })).toEqual({ restricted: true, a: false, b: true });
  });
  it("an inactive key is ignored, whichever way it is restricted", async () => {
    expect(await access({ bearer: "sk-inU", xApiKey: "sk-rA" })).toEqual({ restricted: true, a: true, b: false });
    expect(await access({ bearer: "sk-inR", xApiKey: "sk-rE" })).toEqual({ restricted: true, a: false, b: false });
  });
  it("no valid key → no context, as with no key at all (requireApiKey/middleware decide)", async () => {
    expect(await engine.getKeyAccessContext(webRequest(build({})))).toBeNull();
    expect(await engine.getKeyAccessContext(webRequest(build({ bearer: "sk-junk" })))).toBeNull();
    expect(await engine.getKeyAccessContext(webRequest(build({ bearer: "sk-inR" })))).toBeNull();
  });
  it("a lowercase 'bearer' unrestricted key is not read, so it cannot widen a restricted x-api-key", async () => {
    expect(await access({ rawAuth: "bearer sk-U", xApiKey: "sk-rA" })).toEqual({ restricted: true, a: true, b: false });
  });
  it("an empty Bearer in front of a restricted x-api-key stays restricted", async () => {
    expect(await access({ rawAuth: "Bearer ", xApiKey: "sk-rA" })).toEqual({ restricted: true, a: true, b: false });
  });
  it("a duplicated x-api-key (restricted + unrestricted) is one invalid value: not accepted, not unrestricted by key", async () => {
    const req = new Request("http://router.example.com/v1/chat/completions", {
      method: "POST", headers: [["x-api-key", "sk-rA"], ["x-api-key", "sk-U"]],
    });
    expect((await auth.resolveClientApiKey(req)).valid).toBe(false);
    expect(await engine.getKeyAccessContext(req)).toBeNull();
  });
  it("a repeated ?key= uses only the first value everywhere", async () => {
    const req = new Request("http://router.example.com/v1/chat/completions?key=sk-rA&key=sk-U");
    const ctx = await engine.getKeyAccessContext(req);
    expect(ctx.allow).toEqual(["openai/model-a"]);
  });
});

describe("middleware (dashboardGuard)", () => {
  it("accepts a valid x-api-key even when a stale Authorization header is present", async () => {
    const r = await proxy(nextRequest("/v1/messages", { authorization: "Bearer sk-ant-oat01-stale", "x-api-key": "sk-U" }));
    expect(r.status).toBe(200);
  });
  it("rejects when no presented credential validates (junk, inactive)", async () => {
    const r = await proxy(nextRequest("/v1/messages", { authorization: "Bearer sk-junk", "x-api-key": "sk-inU" }));
    expect(r.status).toBe(401);
  });
  it("returns the Anthropic error envelope on /v1/messages 401", async () => {
    const r = await proxy(nextRequest("/v1/messages", {}));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ type: "error", error: { type: "authentication_error", message: "API key required for remote API access" } });
  });
  it("keeps the legacy error shape on non-Anthropic endpoints", async () => {
    const r = await proxy(nextRequest("/v1/chat/completions", {}));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: "API key required for remote API access" });
  });
});

// ── handlers end to end (real resolveClientApiKey + real key-access engine) ──
const chatBody = (model) => ({ model, max_tokens: 8, stream: true, messages: [{ role: "user", content: "hi" }] });
const chat = (path, slots, model) => handleChat(webRequest(build({ ...slots, path }), chatBody(model)));

describe("chat handler with requireApiKey ON", () => {
  it("Claude Code shape: junk Bearer + unrestricted x-api-key → 200, attributed to the valid key", async () => {
    const r = await chat("/v1/messages", { bearer: "sk-junk", xApiKey: "sk-U" }, "openai/model-b");
    expect(r.status).toBe(200);
    expect(mocks.handleChatCore.mock.calls[0][0].apiKey).toBe("sk-U");
  });
  it("Claude Code shape with a restricted key: allowed target 200, other target Anthropic 403 before credentials", async () => {
    expect((await chat("/v1/messages", { bearer: "sk-junk", xApiKey: "sk-rA" }, "openai/model-a")).status).toBe(200);
    vi.clearAllMocks();
    const r = await chat("/v1/messages", { bearer: "sk-junk", xApiKey: "sk-rA" }, "openai/model-b");
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({
      type: "error",
      error: { type: "permission_error", message: 'This API key is not allowed to use model "openai/model-b"' },
    });
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });
  it("the same denial on /v1/chat/completions keeps the OpenAI shape", async () => {
    const r = await chat("/v1/chat/completions", { bearer: "sk-junk", xApiKey: "sk-rA" }, "openai/model-b");
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error.message).toContain("openai/model-b");
    expect(body.type).toBeUndefined();
  });
  it("401s are Anthropic-shaped on /v1/messages and OpenAI-shaped elsewhere", async () => {
    for (const slots of [{}, { bearer: "sk-junk" }, { xApiKey: "sk-junk" }, { bearer: "sk-inU", xApiKey: "sk-inR" }, { rawAuth: "bearer sk-U" }]) {
      const m = await chat("/v1/messages", slots, "openai/model-a");
      expect(m.status).toBe(401);
      const mb = await m.json();
      expect(mb.type).toBe("error");
      expect(mb.error.type).toBe("authentication_error");
      const c = await chat("/v1/chat/completions", slots, "openai/model-a");
      expect(c.status).toBe(401);
      expect((await c.json()).type).toBeUndefined();
    }
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });
  it("a valid key in x-goog-api-key or ?key= now authenticates in the handler too (same reader as the middleware)", async () => {
    expect((await chat("/v1/chat/completions", { goog: "sk-U" }, "openai/model-a")).status).toBe(200);
    expect((await chat("/v1/chat/completions", { query: "sk-U" }, "openai/model-a")).status).toBe(200);
  });
});

describe("chat handler with requireApiKey OFF", () => {
  beforeEach(() => { fx.settings = { ...fx.settings, requireApiKey: false }; });
  it("junk Bearer + restricted x-api-key is still restricted", async () => {
    expect((await chat("/v1/chat/completions", { bearer: "sk-junk", xApiKey: "sk-rA" }, "openai/model-b")).status).toBe(403);
    expect((await chat("/v1/chat/completions", { bearer: "sk-junk", xApiKey: "sk-rA" }, "openai/model-a")).status).toBe(200);
  });
  it("no key / junk only behaves as before (unrestricted; remote access is the middleware's call)", async () => {
    expect((await chat("/v1/chat/completions", {}, "openai/model-b")).status).toBe(200);
    expect((await chat("/v1/chat/completions", { bearer: "sk-junk" }, "openai/model-b")).status).toBe(200);
  });
});

describe("embeddings handler (plain Bearer and the Claude-style shape)", () => {
  const emb = (slots, model) => handleEmbeddings(webRequest(build({ ...slots, path: "/v1/embeddings" }), { model, input: "x" }));
  it("Bearer <restricted key> is unchanged: allowed 200, other 403", async () => {
    expect((await emb({ bearer: "sk-rA" }, "openai/model-a")).status).toBe(200);
    expect((await emb({ bearer: "sk-rA" }, "openai/model-b")).status).toBe(403);
  });
  it("junk Bearer + restricted x-api-key cannot reach a non-allowed model", async () => {
    expect((await emb({ bearer: "sk-junk", xApiKey: "sk-rA" }, "openai/model-b")).status).toBe(403);
    expect(mocks.handleEmbeddingsCore).not.toHaveBeenCalled();
  });
});
