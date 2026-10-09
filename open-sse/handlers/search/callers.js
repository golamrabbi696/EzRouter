/**
 * Search Provider Request Builders
 *
 * Builds HTTP request `{ url, init }` for 10 search providers.
 *
 * @typedef {Object} SearchProviderConfig
 * @property {string} id
 * @property {string} baseUrl
 * @property {string} [method]
 *
 * @typedef {Object} ContentOptions
 * @property {boolean} [snippet]
 * @property {boolean} [full_page]
 * @property {string}  [format]
 * @property {number}  [max_characters]
 *
 * @typedef {Object} SearchRequestParams
 * @property {string}   query
 * @property {string}   searchType
 * @property {number}   maxResults
 * @property {string}   [token]
 * @property {string}   [country]
 * @property {string}   [language]
 * @property {string}   [timeRange]
 * @property {number}   [offset]
 * @property {string[]} [domainFilter]
 * @property {ContentOptions}        [contentOptions]
 * @property {Record<string,unknown>} [providerOptions]
 * @property {Record<string,unknown>} [providerSpecificData]
 */

import { assertPublicUrl } from "../../../src/shared/utils/ssrfGuard.js";

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Split domain filter into includes / excludes (excludes prefixed with "-").
 * @param {string[]} [domainFilter]
 * @returns {{includes: string[], excludes: string[]}}
 */
export function parseDomainFilter(domainFilter) {
  if (!domainFilter?.length) return { includes: [], excludes: [] };
  const includes = domainFilter.filter((d) => !d.startsWith("-"));
  const excludes = domainFilter.filter((d) => d.startsWith("-")).map((d) => d.slice(1));
  return { includes, excludes };
}

/**
 * Read string setting from providerOptions first, then providerSpecificData.
 * @param {SearchRequestParams} params
 * @param {string} key
 * @returns {string|undefined}
 */
export function getProviderSetting(params, key) {
  const fromOptions = params.providerOptions?.[key];
  if (typeof fromOptions === "string" && fromOptions.trim().length > 0) {
    return fromOptions.trim();
  }
  const fromProviderData = params.providerSpecificData?.[key];
  if (typeof fromProviderData === "string" && fromProviderData.trim().length > 0) {
    return fromProviderData.trim();
  }
  return undefined;
}

/**
 * Read the provider-namespaced passthrough bag from providerOptions.
 *
 * The generic contract only covers the intersection of all providers, so
 * provider-specific request fields reach their builder through
 * `provider_options.<id>`. `getProviderSetting` covers string settings; this
 * covers arbitrary nested values (objects, arrays, booleans, numbers).
 *
 * @param {SearchRequestParams} params
 * @param {string} providerId
 * @returns {Record<string, unknown>}
 */
export function getProviderOptions(params, providerId) {
  const bag = params.providerOptions?.[providerId];
  return bag && typeof bag === "object" && !Array.isArray(bag) ? bag : {};
}

/**
 * Copy allow-listed keys from `source` into `target`, skipping `undefined`.
 *
 * Used to forward provider-specific request fields without exposing the whole
 * client body to the upstream. Keys that fail `accept` are dropped so a client
 * cannot smuggle unsupported values into the request.
 *
 * @param {object}   target
 * @param {object}   source
 * @param {string[]} keys
 * @param {(value: unknown) => boolean} [accept]
 */
export function mergeFields(target, source, keys, accept) {
  if (!source) return target;
  for (const key of keys) {
    const value = source[key];
    if (value === undefined) continue;
    if (accept && !accept(value)) continue;
    target[key] = value;
  }
  return target;
}

/**
 * Map the generic `time_range` onto a provider's own date filter.
 *
 * Only two providers consumed `time_range` before this helper existed; the rest
 * silently dropped it even though their APIs support the equivalent filter.
 *
 * @param {string|undefined} timeRange  One of day|week|month|year.
 * @param {(from: Date) => (Record<string, unknown>|undefined)} toFilter
 * @returns {Record<string, unknown>}
 */
export function applyTimeRange(timeRange, toFilter) {
  if (!timeRange || timeRange === "any") return {};
  const days = { day: 1, week: 7, month: 31, year: 365 }[timeRange];
  if (!days) return {};
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return toFilter(from) || {};
}

/**
 * Resolve base URL with optional override from providerOptions.baseUrl.
 *
 * The override is client-controlled and therefore SSRF-hardened: only public
 * http(s) URLs are accepted (internal/private/loopback/metadata addresses are
 * rejected via assertPublicUrl). The provider's own configured baseUrl is
 * trusted as-is (admin-controlled).
 *
 * @param {SearchProviderConfig} config
 * @param {SearchRequestParams} params
 * @returns {string}
 */
export function resolveBaseUrl(config, params) {
  const override = getProviderSetting(params, "baseUrl");
  if (override) {
    // SSRF guard: client-supplied base URLs must be public http(s) only.
    let parsed;
    try {
      parsed = new URL(override);
    } catch {
      throw new Error(`Invalid baseUrl: ${override}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Invalid baseUrl protocol: ${parsed.protocol}`);
    }
    assertPublicUrl(override);
  }
  return (override || config.baseUrl).replace(/\/+$/, "");
}

/**
 * Convert offset+maxResults to 1-indexed page number.
 * @param {number|undefined} offset
 * @param {number} maxResults
 * @returns {number|undefined}
 */
export function toPageNumber(offset, maxResults) {
  if (typeof offset !== "number" || offset <= 0 || maxResults <= 0) return undefined;
  return Math.floor(offset / maxResults) + 1;
}

// ── Provider Request Builders ───────────────────────────────────────────

function buildSerperRequest(config, params) {
  const endpoint = params.searchType === "news" ? "/news" : "/search";
  const body = { q: params.query, num: params.maxResults };
  if (params.country) body.gl = params.country.toLowerCase();
  if (params.language) body.hl = params.language;
  return {
    url: `${resolveBaseUrl(config, params)}${endpoint}`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": params.token },
      body: JSON.stringify(body),
    },
  };
}

function buildBraveRequest(config, params) {
  const endpoint = params.searchType === "news" ? "/news/search" : "/web/search";
  const qp = new URLSearchParams({ q: params.query, count: String(params.maxResults) });
  if (params.country) qp.set("country", params.country);
  if (params.language) qp.set("search_lang", params.language);
  return {
    url: `${resolveBaseUrl(config, params)}${endpoint}?${qp}`,
    init: {
      method: "GET",
      headers: { Accept: "application/json", "X-Subscription-Token": params.token },
    },
  };
}

function buildPerplexityRequest(config, params) {
  const body = { query: params.query, max_results: params.maxResults };
  if (params.country) body.country = params.country;
  if (params.language) body.search_language_filter = [params.language];
  if (params.domainFilter?.length) body.search_domain_filter = params.domainFilter;
  return {
    url: resolveBaseUrl(config, params),
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${params.token}` },
      body: JSON.stringify(body),
    },
  };
}

function buildExaRequest(config, params) {
  const { includes, excludes } = parseDomainFilter(params.domainFilter);
  const exa = getProviderOptions(params, "exa");

  // `text` and `highlights` belong under `contents` in the current Exa schema;
  // they were previously sent at the top level.
  const body = {
    query: params.query,
    numResults: params.maxResults,
    type: typeof exa.type === "string" ? exa.type : "auto",
    contents: { text: true, highlights: true },
  };
  mergeFields(body.contents, exa.contents, [
    "text", "highlights", "summary", "extras", "subpages", "subpageTarget",
    "livecrawlTimeout", "maxAgeHours",
  ]);
  if (includes.length) body.includeDomains = includes;
  if (excludes.length) body.excludeDomains = excludes;
  if (params.searchType === "news") body.category = "news";

  // time_range was never forwarded to Exa; its equivalent is the published-date
  // window. Explicit startPublishedDate/endPublishedDate from the client win.
  Object.assign(body, applyTimeRange(params.timeRange, (from) => ({
    startPublishedDate: from.toISOString(),
  })));

  // Exa has ~25 documented fields; the generic contract only expresses a
  // handful, so provider_options.exa carries the rest. `stream` and
  // `outputSchema` are deliberately excluded: both turn the response into
  // server-sent synthesized output, which the JSON search contract cannot carry.
  mergeFields(body, exa, [
    "type", "category", "userLocation", "moderation",
    "additionalQueries", "objective", "systemPrompt", "compliance",
    "startPublishedDate", "endPublishedDate",
  ]);

  return {
    url: resolveBaseUrl(config, params),
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": params.token },
      body: JSON.stringify(body),
    },
  };
}

const PARALLEL_MODES = new Set(["turbo", "fast", "basic", "advanced"]);

/** Map 9router time_range to Parallel source_policy.after_date (YYYY-MM-DD). */
function parallelAfterDate(timeRange) {
  if (!timeRange || timeRange === "any") return undefined;
  const from = new Date();
  if (timeRange === "day") from.setUTCDate(from.getUTCDate() - 1);
  else if (timeRange === "week") from.setUTCDate(from.getUTCDate() - 7);
  else if (timeRange === "month" || timeRange === "year") {
    const day = from.getUTCDate();
    from.setUTCDate(1);
    if (timeRange === "month") from.setUTCMonth(from.getUTCMonth() - 1);
    else from.setUTCFullYear(from.getUTCFullYear() - 1);
    const lastDay = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0)).getUTCDate();
    from.setUTCDate(Math.min(day, lastDay));
  }
  else return undefined;
  return from.toISOString().slice(0, 10);
}

function buildParallelRequest(config, params) {
  if (params.searchType && params.searchType !== "web") throw new Error("Unsupported Parallel search type");
  if (params.query.length > 5000) throw new Error("Parallel query must not exceed 5000 characters");
  if (!Number.isInteger(params.maxResults) || params.maxResults < 1 || params.maxResults > 20) {
    throw new Error("Parallel max_results must be an integer from 1 to 20");
  }
  if (params.domainFilter && (!Array.isArray(params.domainFilter) || params.domainFilter.length > 200 || params.domainFilter.some((d) => typeof d !== "string"))) {
    throw new Error("Parallel domain_filter must contain at most 200 domains");
  }
  const { includes, excludes } = parseDomainFilter(params.domainFilter);
  const domains = (list) => list.map((d) => {
    const parsed = new URL(`https://${d.replace(/^https?:\/\//i, "")}`);
    if (!parsed.hostname) throw new Error("Invalid Parallel domain filter");
    return `${parsed.hostname}${parsed.pathname.replace(/\/$/, "")}`;
  });
  const requestedMode = getProviderSetting(params, "mode");
  const mode = requestedMode && PARALLEL_MODES.has(requestedMode) ? requestedMode : "fast";
  const objective = getProviderSetting(params, "objective") || (params.query.length > 200 ? params.query : undefined);
  if (objective?.length > 5000) throw new Error("Parallel objective must not exceed 5000 characters");
  const shortQuery = params.query.length > 200
    ? params.query.slice(0, 200).replace(/\s+\S*$/, "").trim() || params.query.slice(0, 200)
    : params.query;
  const body = {
    search_queries: [shortQuery],
    ...(objective ? { objective } : {}),
    mode,
    advanced_settings: {
      max_results: params.maxResults,
    },
  };

  if (includes.length || excludes.length) {
    body.advanced_settings.source_policy = {
      ...(includes.length ? { include_domains: domains(includes) } : {}),
      ...(excludes.length ? { exclude_domains: domains(excludes) } : {}),
    };
  }
  if (mode === "turbo" && [...(body.advanced_settings.source_policy?.include_domains || []), ...(body.advanced_settings.source_policy?.exclude_domains || [])].some((d) => d.includes("/"))) {
    throw new Error("Parallel turbo mode does not support path-prefix filters");
  }
  const maxChars = params.contentOptions?.max_characters;
  if (maxChars !== undefined) {
    if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error("Parallel max_characters must be a positive integer");
    body.advanced_settings.excerpt_settings = { max_chars_per_result: maxChars };
  }

  const afterDate = parallelAfterDate(params.timeRange);
  if (afterDate) {
    body.advanced_settings.source_policy = {
      ...(body.advanced_settings.source_policy || {}),
      after_date: afterDate,
    };
  }

  if (params.country) {
    const loc = params.country.toLowerCase();
    body.advanced_settings.location = loc === "uk" ? "gb" : loc;
  }

  const sessionId = getProviderSetting(params, "session_id");
  if (sessionId?.length > 1000) throw new Error("Parallel session_id must not exceed 1000 characters");
  if (sessionId) body.session_id = sessionId;

  return {
    // Keep the stored key on the registry endpoint, never client baseUrl overrides.
    url: config.baseUrl,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": params.token },
      body: JSON.stringify(body),
    },
  };
}

function buildTavilyRequest(config, params) {
  const { includes, excludes } = parseDomainFilter(params.domainFilter);
  const tavily = getProviderOptions(params, "tavily");

  const body = {
    query: params.query,
    max_results: params.maxResults,
    topic: typeof tavily.topic === "string" ? tavily.topic : params.searchType,
  };
  if (includes.length) body.include_domains = includes;
  if (excludes.length) body.exclude_domains = excludes;
  if (params.country) body.country = params.country;

  // `search_depth` (advanced|basic|fast|ultra-fast) has no equivalent in the
  // generic contract, and `time_range` was never forwarded to Tavily.
  Object.assign(body, applyTimeRange(params.timeRange, (from) => ({
    start_date: from.toISOString().slice(0, 10),
  })));

  // provider_options.tavily carries the rest of the ~22 documented fields.
  // `include_domains` / `exclude_domains` / `country` / `topic` / `max_results`
  // are omitted: they come from the generic contract above and must win.
  mergeFields(body, tavily, [
    "search_depth", "chunks_per_source", "time_range",
    "start_date", "end_date",
    "include_published_date", "filter_by_published_date",
    "include_answer", "include_raw_content",
    "include_images", "include_image_descriptions", "include_favicon",
    "include_domains_mode", "language", "filter_by_language",
    "auto_parameters", "exact_match", "include_usage", "safe_search",
  ]);

  return {
    url: resolveBaseUrl(config, params),
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${params.token}` },
      body: JSON.stringify(body),
    },
  };
}

function buildGooglePseRequest(config, params) {
  const apiKey = params.token;
  const cx = getProviderSetting(params, "cx");
  if (!apiKey || !cx) {
    throw new Error("Google Programmable Search requires both apiKey and cx");
  }
  const qp = new URLSearchParams({
    key: apiKey,
    cx,
    q: params.query,
    num: String(Math.min(params.maxResults, 10)),
  });
  if (params.country) qp.set("gl", params.country.toLowerCase());
  if (params.language) qp.set("hl", params.language);
  if (params.timeRange && params.timeRange !== "any") {
    const dateRestrictMap = { day: "d1", week: "w1", month: "m1", year: "y1" };
    const dateRestrict = dateRestrictMap[params.timeRange];
    if (dateRestrict) qp.set("dateRestrict", dateRestrict);
  }
  if (typeof params.offset === "number" && params.offset > 0) {
    qp.set("start", String(Math.min(params.offset + 1, 91)));
  }
  return {
    url: `${resolveBaseUrl(config, params)}?${qp}`,
    init: {
      method: "GET",
      headers: { Accept: "application/json" },
    },
  };
}

function buildLinkupRequest(config, params) {
  const apiKey = params.token;
  if (!apiKey) throw new Error("Linkup Search requires an API key");

  const { includes, excludes } = parseDomainFilter(params.domainFilter);
  const requestedDepth = getProviderSetting(params, "depth");
  const depth =
    requestedDepth && ["fast", "standard", "deep"].includes(requestedDepth)
      ? requestedDepth
      : "standard";

  const body = {
    q: params.query,
    depth,
    outputType: "searchResults",
    maxResults: params.maxResults,
  };
  if (includes.length) body.includeDomains = includes;
  if (excludes.length) body.excludeDomains = excludes;
  if (params.timeRange && params.timeRange !== "any") {
    const today = new Date();
    const toDate = today.toISOString().slice(0, 10);
    const from = new Date(today);
    if (params.timeRange === "day") from.setUTCDate(from.getUTCDate() - 1);
    if (params.timeRange === "week") from.setUTCDate(from.getUTCDate() - 7);
    if (params.timeRange === "month") from.setUTCMonth(from.getUTCMonth() - 1);
    if (params.timeRange === "year") from.setUTCFullYear(from.getUTCFullYear() - 1);
    body.fromDate = from.toISOString().slice(0, 10);
    body.toDate = toDate;
  }

  return {
    url: resolveBaseUrl(config, params),
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    },
  };
}

function buildSearchApiRequest(config, params) {
  const apiKey = params.token;
  if (!apiKey) throw new Error("SearchAPI requires an API key");

  const qp = new URLSearchParams({
    engine: params.searchType === "news" ? "google_news" : "google",
    q: params.query,
    api_key: apiKey,
  });
  if (params.country) qp.set("gl", params.country.toLowerCase());
  if (params.language) qp.set("hl", params.language);

  const page = toPageNumber(params.offset, params.maxResults);
  if (page) qp.set("page", String(page));

  return {
    url: `${resolveBaseUrl(config, params)}?${qp}`,
    init: {
      method: "GET",
      headers: { Accept: "application/json" },
    },
  };
}

function buildYouComRequest(config, params) {
  const apiKey = params.token;
  if (!apiKey) throw new Error("You.com Search requires an API key");

  const { includes, excludes } = parseDomainFilter(params.domainFilter);
  const qp = new URLSearchParams({
    query: params.query,
    count: String(Math.min(params.maxResults, 100)),
  });

  if (params.timeRange && params.timeRange !== "any") qp.set("freshness", params.timeRange);
  if (typeof params.offset === "number" && params.offset > 0 && params.maxResults > 0) {
    qp.set("offset", String(Math.min(Math.floor(params.offset / params.maxResults), 9)));
  }
  if (params.country) qp.set("country", params.country);
  if (params.language) qp.set("language", params.language);
  if (includes.length) qp.set("include_domains", includes.join(","));
  if (excludes.length) qp.set("exclude_domains", excludes.join(","));

  if (params.contentOptions?.full_page) {
    qp.set("livecrawl", params.searchType === "news" ? "news" : "web");
    qp.append(
      "livecrawl_formats",
      params.contentOptions.format === "markdown" ? "markdown" : "html"
    );
  }

  return {
    url: `${resolveBaseUrl(config, params)}?${qp}`,
    init: {
      method: "GET",
      headers: { Accept: "application/json", "X-API-Key": apiKey },
    },
  };
}

function buildSearxngRequest(config, params) {
  const baseUrl = resolveBaseUrl(config, params);
  const url = baseUrl.endsWith("/search") ? baseUrl : `${baseUrl}/search`;
  const qp = new URLSearchParams({
    q: params.query,
    format: "json",
    categories: params.searchType === "news" ? "news" : "general",
  });
  if (params.language) qp.set("language", params.language);
  if (params.timeRange && params.timeRange !== "any") qp.set("time_range", params.timeRange);

  const page = toPageNumber(params.offset, params.maxResults);
  if (page) qp.set("pageno", String(page));

  return {
    url: `${url}?${qp}`,
    init: {
      method: "GET",
      headers: { Accept: "application/json" },
    },
  };
}

function buildXquikRequest(config, params) {
  const apiKey = params.token;
  if (!apiKey) throw new Error("Xquik requires an API key");

  const queryType = getProviderSetting(params, "queryType");
  if (queryType && !["Latest", "Top"].includes(queryType)) {
    throw new Error("Xquik queryType must be Latest or Top");
  }

  const qp = new URLSearchParams({
    q: params.query,
    limit: String(params.maxResults),
  });
  const cursor = getProviderSetting(params, "cursor");
  if (cursor) qp.set("cursor", cursor);
  if (queryType) qp.set("queryType", queryType);
  if (params.language) qp.set("language", params.language);

  return {
    url: `${resolveBaseUrl(config, params)}?${qp}`,
    init: {
      method: "GET",
      headers: { Accept: "application/json", "x-api-key": apiKey },
    },
  };
}

function buildTinyfishRequest(config, params) {
  if (params.searchType && !["web", "news", "research_paper"].includes(params.searchType)) {
    throw new Error("Unsupported TinyFish search type");
  }
  const qp = new URLSearchParams({ query: params.query });
  if (params.searchType && params.searchType !== "web") qp.set("domain_type", params.searchType);
  if (params.country) qp.set("location", params.country);
  if (params.language) qp.set("language", params.language);
  const { includes, excludes } = parseDomainFilter(params.domainFilter);
  if (includes.length) qp.set("include_domains", includes.join(","));
  if (excludes.length) qp.set("exclude_domains", excludes.join(","));
  if (Number.isInteger(params.offset) && params.offset > 0) {
    if (params.offset >= 110) throw new Error("TinyFish search offset exceeds available pages");
    if (params.offset % 10 + params.maxResults > 10) throw new Error("TinyFish search offset and max_results must fit within one page");
    qp.set("page", String(Math.floor(params.offset / 10)));
  }
  return {
    // Keep API-key endpoint fixed; client baseUrl overrides must not receive the key.
    url: `${config.baseUrl}?${qp}`,
    init: { method: "GET", headers: { Accept: "application/json", "X-API-Key": params.token } },
  };
}

// ── Ollama Cloud web_search ──────────────────────────────────────────────
// POST https://ollama.com/api/web_search { query, max_results }
// Response: { results: [{ title, url, content, published_at? }] }
function buildOllamaSearchRequest(config, params) {
  const body = { query: params.query, max_results: params.maxResults };
  if (params.country) body.country = params.country;
  if (params.language) body.language = params.language;
  return {
    url: resolveBaseUrl(config, params),
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(params.token ? { Authorization: `Bearer ${params.token}` } : {}),
      },
      body: JSON.stringify(body),
    },
  };
}

// ── GLM Coding plan MCP web_search_prime ──────────────────────────────────
// POST https://api.z.ai/api/mcp/web_search_prime/mcp
// JSON-RPC envelope: { jsonrpc, id, method: "tools/call",
//   params: { name: "web_search_prime", arguments: { search_query, count } } }
// Response: { result: { content: [{ type: "text", text: "<json>" }] } }
function buildGlmSearchRequest(config, params) {
  const body = {
    jsonrpc: "2.0",
    id: `9r-${Date.now()}`,
    method: "tools/call",
    params: {
      name: "web_search_prime",
      arguments: { search_query: params.query, count: params.maxResults },
    },
  };
  return {
    url: resolveBaseUrl(config, params),
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(params.token ? { Authorization: `Bearer ${params.token}` } : {}),
      },
      body: JSON.stringify(body),
    },
  };
}

// ── Dispatcher ──────────────────────────────────────────────────────────

const BUILDERS = {
  "serper": buildSerperRequest,
  "brave-search": buildBraveRequest,
  "perplexity": buildPerplexityRequest,
  "exa": buildExaRequest,
  "parallel": buildParallelRequest,
  "tavily": buildTavilyRequest,
  "google-pse": buildGooglePseRequest,
  "linkup": buildLinkupRequest,
  "searchapi": buildSearchApiRequest,
  "youcom": buildYouComRequest,
  "searxng": buildSearxngRequest,
  "xquik": buildXquikRequest,
  "tinyfish": buildTinyfishRequest,
  "ollama-search": buildOllamaSearchRequest,
  "glm": buildGlmSearchRequest,
};

/**
 * Dispatch to the correct provider builder by `provider.id`.
 * Falls back to generic POST + bearer auth for unknown providers.
 * @param {SearchProviderConfig} provider
 * @param {SearchRequestParams} params
 * @returns {{url: string, init: RequestInit}}
 */
export function buildSearchRequest(provider, params) {
  const builder = BUILDERS[provider.id];
  if (builder) return builder(provider, params);

  return {
    url: resolveBaseUrl(provider, params),
    init: {
      method: provider.method || "POST",
      headers: {
        "Content-Type": "application/json",
        ...(params.token ? { Authorization: `Bearer ${params.token}` } : {}),
      },
      body: JSON.stringify({
        query: params.query,
        max_results: params.maxResults,
        search_type: params.searchType,
      }),
    },
  };
}
