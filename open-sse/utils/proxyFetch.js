import { Readable } from "stream";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { dbg } from "./debugLog.js";

const originalFetch = globalThis.fetch;
const proxyDispatchers = new Map();

// ─── TLS fingerprinting via got-scraping (browser-like JA3) ───────────────
// Re-enabled per-host: api.anthropic.com (non-streaming) routes through
// got-scraping for a browser-like JA3 fingerprint, failing open to native
// fetch when got-scraping is unavailable or throws.

let _gotScraping = null;
let _gotScrapingChecked = false;
const _gotScrapingLoggedHosts = new Set();

async function getGotScraping() {
  if (_gotScrapingChecked) return _gotScraping;
  _gotScrapingChecked = true;
  try {
    const mod = await import("got-scraping");
    _gotScraping = typeof mod.gotScraping === "function" ? mod.gotScraping : null;
    if (_gotScraping) dbg("TLS", "got-scraping loaded (browser-like JA3 enabled)");
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping unavailable, falling back to native fetch: ${e.message}`);
    _gotScraping = null;
  }
  return _gotScraping;
}

// Convert got-scraping's response shape { statusCode, statusMessage, headers,
// rawBody } into a web-standard Response (with ok/status/json).
function gotScrapingResponseToWeb(res) {
  const status = res?.statusCode || res?.status || 200;
  const headers = new Headers();
  if (res?.headers) {
    for (const [k, v] of Object.entries(res.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, String(x)));
      else if (v != null) headers.set(k, String(v));
    }
  }
  let bodyBuf;
  if (res?.rawBody instanceof Uint8Array) bodyBuf = res.rawBody;
  else if (Buffer.isBuffer(res?.rawBody)) bodyBuf = res.rawBody;
  else bodyBuf = Buffer.from(JSON.stringify(res?.body ?? {}));
  return new Response(bodyBuf, { status, statusText: res?.statusMessage || "", headers });
}

async function gotScrapingFetch(url, options) {
  const gs = await getGotScraping();
  if (!gs) return null;

  const method = (options.method || "GET").toUpperCase();
  const headersInit = options.headers || {};
  const headers = headersInit instanceof Headers
    ? Object.fromEntries(headersInit.entries())
    : { ...headersInit };

  // Non-streaming: call got-scraping directly (the function form), then adapt
  // the response. Streaming is not needed for the api.anthropic.com route here.
  const res = await gs(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : options.body,
    throwHttpErrors: false,
    retry: { limit: 0 },
    followRedirect: false,
    decompress: true,
    signal: options.signal,
  });

  const host = (() => { try { return new URL(typeof url === "string" ? url : url.toString()).hostname; } catch { return ""; } })();
  if (host && !_gotScrapingLoggedHosts.has(host)) {
    _gotScrapingLoggedHosts.add(host);
    dbg("TLS", `using got-scraping for ${host}`);
  }

  return gotScrapingResponseToWeb(res);
}

async function tryGotScrapingFetch(url, options) {
  try {
    const res = await gotScrapingFetch(url, options);
    return res;
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping request failed, fallback to native fetch: ${e.message}`);
    return null;
  }
}

// DNS cache — use Map to avoid prototype pollution via malformed hostnames
const DNS_CACHE = new Map();
const MITM_BYPASS_HOSTS = [
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "api2.cursor.sh",
];
const GOOGLE_DNS_SERVERS = ["8.8.8.8", "8.8.4.4"];

// Connection pool limits — prevent exhaustion under concurrent upstream load
const MAX_CONNECTIONS_PER_ORIGIN = 32;
const MAX_FREE_CONNECTIONS_PER_ORIGIN = 16;
const KEEP_ALIVE_TIMEOUT = 60_000;
const CONNECTION_TIMEOUT = 30_000;
const BODY_TIMEOUT = 300_000;
const PROXY_MAX_CONNECTIONS = 64;
const PROXY_MAX_FREE_CONNECTIONS = 32;

let sharedDirectAgent = null;
const bypassAgentByHost = new Map();

async function getDirectAgent() {
  if (sharedDirectAgent) return sharedDirectAgent;
  const { Agent } = await import("undici");
  sharedDirectAgent = new Agent({
    connections: MAX_CONNECTIONS_PER_ORIGIN,
    keepAliveMaxTimeout: KEEP_ALIVE_TIMEOUT,
    keepAliveTimeout: 4000,
    bodyTimeout: BODY_TIMEOUT,
    headersTimeout: 60_000,
    connectTimeout: CONNECTION_TIMEOUT,
    pipelining: 1,
    maxCachedSessions: MAX_FREE_CONNECTIONS_PER_ORIGIN,
  });
  return sharedDirectAgent;
}

async function getBypassAgent(hostname, realIP) {
  const key = `${hostname}:${realIP}`;
  if (bypassAgentByHost.has(key)) return bypassAgentByHost.get(key);

  if (bypassAgentByHost.size >= 50) {
    const first = bypassAgentByHost.keys().next().value;
    const agent = bypassAgentByHost.get(first);
    try { agent.destroy(); } catch {}
    bypassAgentByHost.delete(first);
  }

  const { Agent } = await import("undici");
  const agent = new Agent({
    connect: {
      hostname: realIP,
      servername: hostname,
      rejectUnauthorized: true,
    },
    connections: MAX_CONNECTIONS_PER_ORIGIN,
    keepAliveMaxTimeout: KEEP_ALIVE_TIMEOUT,
    keepAliveTimeout: 4000,
    bodyTimeout: BODY_TIMEOUT,
    headersTimeout: 60_000,
    connectTimeout: CONNECTION_TIMEOUT,
    pipelining: 1,
    maxCachedSessions: MAX_FREE_CONNECTIONS_PER_ORIGIN,
  });
  bypassAgentByHost.set(key, agent);
  return agent;
}

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Resolve real IP using Google DNS (bypass system DNS)
 */
async function resolveRealIP(hostname) {
  const cached = DNS_CACHE.get(hostname);
  if (cached && Date.now() < cached.expiry) return cached.ip;

  try {
    const dns = await import("dns");
    const { promisify } = await import("util");
    const resolver = new dns.Resolver();
    resolver.setServers(GOOGLE_DNS_SERVERS);
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    const addresses = await resolve4(hostname);
    DNS_CACHE.set(hostname, { ip: addresses[0], expiry: Date.now() + MEMORY_CONFIG.dnsCacheTtlMs });
    return addresses[0];
  } catch (error) {
    console.warn(`[ProxyFetch] DNS resolve failed for ${hostname}:`, error.message);
    return null;
  }
}

/**
 * Check if request should bypass MITM DNS redirect
 */
function shouldBypassMitmDns(url) {
  try {
    const hostname = new URL(url).hostname;
    return MITM_BYPASS_HOSTS.some(host => hostname.includes(host));
  } catch { return false; }
}

function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = normalizeString(noProxyValue);
  if (!noProxy) return false;

  let hostname;
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { return false; }
  const patterns = noProxy.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);

  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

/**
 * Get proxy URL from environment
 */
function getEnvProxyUrl(targetUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  let protocol;
  try { protocol = new URL(targetUrl).protocol; } catch { return null; }

  if (protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.ALL_PROXY || process.env.all_proxy;
  }

  return process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy;
}

/**
 * Normalize proxy URL (allow host:port)
 */
function normalizeProxyUrl(proxyUrl) {
  const normalizedInput = normalizeString(proxyUrl);
  if (!normalizedInput) return null;

  try {

    new URL(normalizedInput);
    return normalizedInput;
  } catch {
    // Allow "127.0.0.1:7890" style values
    return `http://${normalizedInput}`;
  }
}

function resolveConnectionProxyUrl(targetUrl, proxyOptions) {
  const enabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
  if (!enabled) return null;

  const proxyUrlRaw = normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  if (!proxyUrlRaw) return null;

  const noProxy = normalizeString(proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy);
  if (noProxy && shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  return normalizeProxyUrl(proxyUrlRaw);
}

/**
 * Create proxy dispatcher lazily (undici-compatible) with connection limits
 */
async function getDispatcher(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return null;

  if (!proxyDispatchers.has(normalized)) {
    if (proxyDispatchers.size >= MEMORY_CONFIG.proxyDispatchersMaxSize) {
      proxyDispatchers.delete(proxyDispatchers.keys().next().value);
    }
    const { ProxyAgent } = await import("undici");
    proxyDispatchers.set(normalized, new ProxyAgent({
      uri: normalized,
      connections: PROXY_MAX_CONNECTIONS,
      keepAliveMaxTimeout: KEEP_ALIVE_TIMEOUT,
      keepAliveTimeout: 4000,
      bodyTimeout: BODY_TIMEOUT,
      headersTimeout: 60_000,
      connectTimeout: CONNECTION_TIMEOUT,
      pipelining: 1,
      maxCachedSessions: PROXY_MAX_FREE_CONNECTIONS,
    }));
  }

  return proxyDispatchers.get(normalized);
}

/**
 * Create pooled HTTPS request that resolves to real IP (bypass DNS spoof).
 * Uses a per-host undici Agent with connection limits to avoid exhaustion.
 */
async function createBypassRequest(parsedUrl, realIP, options) {
  const hostname = parsedUrl.hostname;
  const agent = await getBypassAgent(hostname, realIP);

  const url = `https://${hostname}${parsedUrl.pathname}${parsedUrl.search}`;

  const response = await originalFetch(url, {
    method: options.method || "POST",
    headers: { ...options.headers, Host: hostname },
    body: options.body,
    dispatcher: agent,
  });

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: new Map(response.headers),
    body: response.body,
    text: async () => await response.text(),
    json: async () => await response.json(),
  };
}

export async function proxyAwareFetch(url, options = {}, proxyOptions = null) {
  const targetUrl = typeof url === "string" ? url : url.toString();

  // Vercel relay: forward request via relay headers
  const vercelRelayUrl = normalizeString(proxyOptions?.vercelRelayUrl);
  if (vercelRelayUrl) {
    const parsed = new URL(targetUrl);
    const relayHeaders = {
      ...options.headers,
      "x-relay-target": `${parsed.protocol}//${parsed.host}`,
      "x-relay-path": `${parsed.pathname}${parsed.search}`,
    };
    return originalFetch(vercelRelayUrl, { ...options, headers: relayHeaders });
  }

  const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);
  const envProxyUrl = connectionProxyUrl ? null : normalizeProxyUrl(getEnvProxyUrl(targetUrl));
  const proxyUrl = connectionProxyUrl || envProxyUrl;

  // MITM DNS bypass: for known MITM-intercepted hosts, resolve real IP to avoid DNS spoof
  if (shouldBypassMitmDns(targetUrl)) {
    if (proxyUrl) {
      // Proxy resolves DNS externally (not affected by /etc/hosts) — use proxy directly
      try {
        const dispatcher = await getDispatcher(proxyUrl);
        return await originalFetch(url, { ...options, dispatcher });
      } catch (proxyError) {
        if (proxyOptions?.strictProxy === true) {
          throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`);
        }
        console.warn(`[ProxyFetch] Proxy failed, falling back to direct bypass: ${proxyError.message}`);
      }
    }
    // No proxy — manually resolve real IP to bypass DNS spoof
    try {
      const parsedUrl = new URL(targetUrl);
      const realIP = await resolveRealIP(parsedUrl.hostname);
      if (realIP) return await createBypassRequest(parsedUrl, realIP, options);
    } catch (error) {
      console.warn(`[ProxyFetch] MITM bypass failed: ${error.message}`);
    }
  }

  if (proxyUrl) {
    try {
      const dispatcher = await getDispatcher(proxyUrl);
      return await originalFetch(url, { ...options, dispatcher });
    } catch (proxyError) {
      if (proxyOptions?.strictProxy === true) {
        throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`);
      }
      console.warn(`[ProxyFetch] Proxy failed, falling back to direct: ${proxyError.message}`);
      const agent = await getDirectAgent();
      return originalFetch(url, { ...options, dispatcher: agent });
    }
  }

  // api.anthropic.com (non-streaming) routes through got-scraping for a
  // browser-like JA3 fingerprint; falls open to native fetch on any failure.
  const wantsStream = !!(options.headers && (options.headers["Accept"] === "text/event-stream" || (options.headers instanceof Headers && options.headers.get("accept") === "text/event-stream")));
  let host;
  try { host = new URL(targetUrl).hostname; } catch { host = ""; }
  if (host === "api.anthropic.com" && !wantsStream) {
    const gsRes = await tryGotScrapingFetch(url, options);
    if (gsRes) return gsRes;
    const agent = await getDirectAgent();
    return originalFetch(url, { ...options, dispatcher: agent });
  }

  const agent = await getDirectAgent();
  return originalFetch(url, { ...options, dispatcher: agent });
}

/**
 * Patched global fetch with env-proxy support, MITM DNS bypass, and connection limits
 */
async function patchedFetch(url, options = {}) {
  const targetUrl = typeof url === "string" ? url : url.toString();

  if (shouldBypassMitmDns(targetUrl)) {
    try {
      const parsedUrl = new URL(targetUrl);
      const cached = DNS_CACHE.get(parsedUrl.hostname);
      if (cached && Date.now() < cached.expiry) {
        const agent = await getBypassAgent(parsedUrl.hostname, cached.ip);
        return originalFetch(url, { ...options, dispatcher: agent });
      }
    } catch {}
  }

  const agent = await getDirectAgent();
  return originalFetch(url, { ...options, dispatcher: agent });
}

// Idempotency guard — only patch once to avoid wrapping multiple times
if (globalThis.fetch !== patchedFetch) {
  globalThis.fetch = patchedFetch;
}

export default patchedFetch;
