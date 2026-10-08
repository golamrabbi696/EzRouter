import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getCombos: vi.fn(),
  getProviderCredentials: vi.fn(),
  handleSearchCore: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getCombos: mocks.getCombos,
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(() => true),
  resolveClientApiKey: vi.fn(async () => ({ apiKey: null, valid: true })),
}));

vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: vi.fn((_id, credentials) => credentials),
}));

vi.mock("open-sse/handlers/search/index.js", () => ({
  handleSearchCore: mocks.handleSearchCore,
}));

const { handleSearch } = await import("../../src/sse/handlers/search.js");

const RESPONSE = { status: 200, body: { results: [] } };

function searchRequest(body) {
  return new Request("http://localhost/api/v1/search", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("handleSearch Exa-native client compatibility", () => {
  beforeEach(() => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.getCombos.mockResolvedValue(null);
    mocks.getProviderCredentials.mockResolvedValue({ connectionId: "c1", connectionName: "exa-key", apiKey: "k" });
    mocks.handleSearchCore.mockResolvedValue({ success: true, response: RESPONSE });
  });

  afterEach(() => {
    delete process.env.DEFAULT_SEARCH_PROVIDER;
    vi.clearAllMocks();
  });

  it("routes provider-less Exa-native requests via DEFAULT_SEARCH_PROVIDER and maps numResults/domain filters", async () => {
    process.env.DEFAULT_SEARCH_PROVIDER = "exa";
    const response = await handleSearch(
      searchRequest({
        query: "pi coding agent",
        numResults: 7,
        type: "neural",
        useAutoprompt: true,
        includeDomains: ["github.com"],
        excludeDomains: ["example.com"],
      })
    );

    expect(response).toBe(RESPONSE);
    const { body } = mocks.handleSearchCore.mock.calls[0][0];
    expect(body).toMatchObject({
      provider: "exa",
      query: "pi coding agent",
      max_results: 7,
      domain_filter: ["github.com", "-example.com"],
    });
    // Exa-native request params must not leak into the core body
    expect(body).not.toHaveProperty("numResults");
    expect(body).not.toHaveProperty("type");
  });

  it("keeps max_results and domain_filter precedence over Exa-native fields", async () => {
    process.env.DEFAULT_SEARCH_PROVIDER = "exa";
    const response = await handleSearch(
      searchRequest({
        query: "pi coding agent",
        numResults: 99,
        max_results: 3,
        domain_filter: ["a.com"],
        includeDomains: ["ignored.com"],
      })
    );

    expect(response).toBe(RESPONSE);
    const { body } = mocks.handleSearchCore.mock.calls[0][0];
    expect(body.max_results).toBe(3);
    expect(body.domain_filter).toEqual(["a.com"]);
  });

  it("rejects provider-less requests when DEFAULT_SEARCH_PROVIDER is not set", async () => {
    const response = await handleSearch(searchRequest({ query: "pi coding agent", numResults: 7 }));
    expect(response.status).toBe(400);
    expect(mocks.handleSearchCore).not.toHaveBeenCalled();
  });

  it("tolerates non-array Exa-native domain fields", async () => {
    process.env.DEFAULT_SEARCH_PROVIDER = "exa";
    await handleSearch(searchRequest({ query: "pi coding agent", includeDomains: "not-an-array" }));

    const { body } = mocks.handleSearchCore.mock.calls[0][0];
    expect(body.domain_filter).toBeUndefined();
  });
});
