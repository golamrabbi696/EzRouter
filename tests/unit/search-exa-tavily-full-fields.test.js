import { afterEach, describe, expect, it, vi } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { buildSearchRequest } from "../../open-sse/handlers/search/callers.js";
import { normalizeSearchResponse } from "../../open-sse/handlers/search/normalizers.js";

const EXA_CONFIG = {
  id: "exa",
  baseUrl: "https://api.exa.ai/search",
  method: "POST",
  authType: "apikey",
  authHeader: "bearer",
  searchTypes: ["web", "news"],
  defaultMaxResults: 5,
  maxMaxResults: 100,
};

const EXA_PARAMS = {
  query: "kubernetes gateway api",
  searchType: "web",
  maxResults: 10,
  token: "exa_test_key",
};

const TAVILY_CONFIG = {
  id: "tavily",
  baseUrl: "https://api.tavily.com/search",
  method: "POST",
  authType: "apikey",
  authHeader: "bearer",
  searchTypes: ["web", "news", "finance"],
  defaultMaxResults: 5,
  maxMaxResults: 20,
};

const TAVILY_PARAMS = {
  query: "nvidia earnings",
  searchType: "finance",
  maxResults: 5,
  token: "tvly_test_key",
};

function readBody(request) {
  return JSON.parse(request.init.body);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Exa full-field request coverage", () => {
  it("nests text and highlights under contents", () => {
    const body = readBody(buildSearchRequest(EXA_CONFIG, EXA_PARAMS));

    expect(body.contents).toEqual({ text: true, highlights: true });
    // The old shape sent these at the top level; they must not leak back out.
    expect(body.text).toBeUndefined();
    expect(body.highlights).toBeUndefined();
  });

  it("forwards the documented fields from provider_options.exa", () => {
    const body = readBody(buildSearchRequest(EXA_CONFIG, {
      ...EXA_PARAMS,
      providerOptions: {
        exa: {
          type: "deep",
          category: "company",
          userLocation: "US",
          additionalQueries: ["gpu roadmap"],
          compliance: { hipaa: true },
          contents: {
            summary: { query: "key risks" },
            extras: { links: 3 },
            maxAgeHours: 48,
          },
        },
      },
    }));

    expect(body.type).toBe("deep");
    expect(body.category).toBe("company");
    expect(body.userLocation).toBe("US");
    expect(body.additionalQueries).toEqual(["gpu roadmap"]);
    expect(body.compliance).toEqual({ hipaa: true });
    expect(body.contents.summary).toEqual({ query: "key risks" });
    expect(body.contents.extras).toEqual({ links: 3 });
    expect(body.contents.maxAgeHours).toBe(48);
  });

  it("excludes stream and outputSchema because they break the JSON contract", () => {
    const body = readBody(buildSearchRequest(EXA_CONFIG, {
      ...EXA_PARAMS,
      providerOptions: {
        exa: { stream: true, outputSchema: { type: "object" }, systemPrompt: "be terse" },
      },
    }));

    expect(body.stream).toBeUndefined();
    expect(body.outputSchema).toBeUndefined();
    expect(body.systemPrompt).toBe("be terse");
  });

  it("maps time_range onto startPublishedDate and lets an explicit date win", () => {
    const mapped = readBody(buildSearchRequest(EXA_CONFIG, { ...EXA_PARAMS, timeRange: "week" }));
    expect(mapped.startPublishedDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const mappedAt = Date.parse(mapped.startPublishedDate);
    const ageDays = (Date.now() - mappedAt) / 86_400_000;
    expect(ageDays).toBeGreaterThan(6.5);
    expect(ageDays).toBeLessThan(7.5);

    const explicit = readBody(buildSearchRequest(EXA_CONFIG, {
      ...EXA_PARAMS,
      timeRange: "week",
      providerOptions: { exa: { startPublishedDate: "2026-01-01T00:00:00Z" } },
    }));
    expect(explicit.startPublishedDate).toBe("2026-01-01T00:00:00Z");
  });

  it("still sends the generic contract fields alongside provider_options.exa", () => {
    const body = readBody(buildSearchRequest(EXA_CONFIG, {
      ...EXA_PARAMS,
      searchType: "news",
      domainFilter: ["arxiv.org", "-example.com"],
      providerOptions: { exa: { type: "deep" } },
    }));

    expect(body.query).toBe("kubernetes gateway api");
    expect(body.numResults).toBe(10);
    expect(body.category).toBe("news");
    expect(body.includeDomains).toEqual(["arxiv.org"]);
    expect(body.excludeDomains).toEqual(["example.com"]);
    expect(body.type).toBe("deep");
  });

  it("keeps top-level text/highlights when the client supplies them", () => {
    const body = readBody(buildSearchRequest(EXA_CONFIG, {
      ...EXA_PARAMS,
      providerOptions: { exa: { contents: { text: { maxCharacters: 500 } } } },
    }));

    expect(body.contents).toEqual({
      text: { maxCharacters: 500 },
      highlights: true,
    });
  });
});

describe("Tavily full-field request coverage", () => {
  it("registers the finance topic", () => {
    const entry = REGISTRY.find((candidate) => candidate.id === "tavily");
    expect(entry.searchConfig.searchTypes).toContain("finance");
  });

  it("passes the search type through as the topic", () => {
    const body = readBody(buildSearchRequest(TAVILY_CONFIG, TAVILY_PARAMS));

    expect(body.topic).toBe("finance");
    expect(body.query).toBe("nvidia earnings");
    expect(body.max_results).toBe(5);
  });

  it("forwards the documented fields from provider_options.tavily", () => {
    const body = readBody(buildSearchRequest(TAVILY_CONFIG, {
      ...TAVILY_PARAMS,
      providerOptions: {
        tavily: {
          search_depth: "advanced",
          chunks_per_source: 3,
          include_answer: "advanced",
          include_raw_content: true,
          include_images: true,
          include_image_descriptions: true,
          include_favicon: true,
          include_domains_mode: "promote",
          language: "en",
          filter_by_language: true,
          auto_parameters: true,
          exact_match: true,
          include_usage: true,
          safe_search: true,
        },
      },
    }));

    expect(body.search_depth).toBe("advanced");
    expect(body.chunks_per_source).toBe(3);
    expect(body.include_answer).toBe("advanced");
    expect(body.include_raw_content).toBe(true);
    expect(body.include_images).toBe(true);
    expect(body.include_image_descriptions).toBe(true);
    expect(body.include_favicon).toBe(true);
    expect(body.include_domains_mode).toBe("promote");
    expect(body.language).toBe("en");
    expect(body.filter_by_language).toBe(true);
    expect(body.auto_parameters).toBe(true);
    expect(body.exact_match).toBe(true);
    expect(body.include_usage).toBe(true);
    expect(body.safe_search).toBe(true);
  });

  it("does not let provider_options.tavily override the generic contract", () => {
    const body = readBody(buildSearchRequest(TAVILY_CONFIG, {
      ...TAVILY_PARAMS,
      domainFilter: ["sec.gov", "-spam.example"],
      country: "US",
      providerOptions: {
        tavily: {
          topic: "general",
          max_results: 99,
          include_domains: ["evil.example"],
          exclude_domains: ["good.example"],
          country: "DE",
        },
      },
    }));

    expect(body.topic).toBe("general");
    expect(body.max_results).toBe(5);
    expect(body.include_domains).toEqual(["sec.gov"]);
    expect(body.exclude_domains).toEqual(["spam.example"]);
    expect(body.country).toBe("US");
  });

  it("maps time_range onto start_date and lets an explicit date win", () => {
    const mapped = readBody(buildSearchRequest(TAVILY_CONFIG, { ...TAVILY_PARAMS, timeRange: "month" }));
    expect(mapped.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const mappedDays = (Date.now() - Date.parse(mapped.start_date)) / 86_400_000;
    expect(mappedDays).toBeGreaterThan(29);

    const explicit = readBody(buildSearchRequest(TAVILY_CONFIG, {
      ...TAVILY_PARAMS,
      timeRange: "month",
      providerOptions: { tavily: { start_date: "2026-02-01", end_date: "2026-02-28" } },
    }));
    expect(explicit.start_date).toBe("2026-02-01");
    expect(explicit.end_date).toBe("2026-02-28");
  });

  it("ignores an unrecognized time_range instead of inventing a window", () => {
    const body = readBody(buildSearchRequest(TAVILY_CONFIG, { ...TAVILY_PARAMS, timeRange: "century" }));
    expect(body.start_date).toBeUndefined();
  });
});

describe("Exa and Tavily response normalization", () => {
  it("keeps Exa fields the unified shape has no home for", () => {
    const normalized = normalizeSearchResponse("exa", {
      results: [{
        id: "exa-result-1",
        title: "Gateway API",
        url: "https://gateway-api.sigs.k8s.io/",
        highlights: ["Stable in 1.2"],
        highlightScores: [0.98],
        summary: { text: "Kubernetes Gateway API graduated." },
        subpages: [{ url: "https://example.com/sub" }],
        entities: [{ name: "Kubernetes" }],
        extras: { links: 3 },
      }],
    }, "kubernetes gateway api", "web");

    expect(normalized.results[0].provider_raw).toEqual({
      id: "exa-result-1",
      highlight_scores: [0.98],
      summary: { text: "Kubernetes Gateway API graduated." },
      subpages: [{ url: "https://example.com/sub" }],
      entities: [{ name: "Kubernetes" }],
      extras: { links: 3 },
    });
  });

  it("keeps Tavily images and favicon the unified shape drops", () => {
    const normalized = normalizeSearchResponse("tavily", {
      results: [{
        title: "Earnings call",
        url: "https://investor.nvidia.com/",
        content: "Revenue grew 62%.",
        raw_content: "Full transcript text.",
        images: ["https://investor.nvidia.com/chart.png"],
        favicon: "https://investor.nvidia.com/favicon.ico",
      }],
    }, "nvidia earnings", "finance");

    expect(normalized.results[0].provider_raw).toEqual({
      images: ["https://investor.nvidia.com/chart.png"],
      favicon: "https://investor.nvidia.com/favicon.ico",
    });
  });

  it("leaves provider_raw null when the upstream sends no extra fields", () => {
    const exa = normalizeSearchResponse("exa", {
      results: [{ title: "Plain", url: "https://example.com" }],
    }, "plain", "web");
    const tavily = normalizeSearchResponse("tavily", {
      results: [{ title: "Plain", url: "https://example.com" }],
    }, "plain", "web");

    expect(exa.results[0].provider_raw).toBeNull();
    expect(tavily.results[0].provider_raw).toBeNull();
  });
});
