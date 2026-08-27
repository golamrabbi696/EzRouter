import crypto from "crypto";
import https from "https";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { applyOcEgress } from "../utils/ocEgress.js";

// Official opencode CLI sends "opencode/<version>" (e.g. opencode/1.18.18).
// OpenCode Zen's free-tier ("-free") models gate anonymous capacity on this
// User-Agent — a bare "opencode" or any non-opencode UA is still classified
// as unidentified and gets FreeUsageLimitError/429 immediately. Keep the
// version in sync with opencode releases when it bumps.
const OPENCODE_UA = "opencode/latest/1.18.18/cli";

function generateRequestId() {
  return `msg_${crypto.randomUUID().replace(/-/g, "")}`;
}

function generateSessionId() {
  return `ses_${crypto.randomUUID().replace(/-/g, "")}`;
}

// Normalize any resolved id into opencode's ses_ format (stable per-conversation)
function toOpencodeSession(id) {
  const stripped = String(id || "").replace(/^ses_/, "").replace(/-/g, "");
  return stripped ? `ses_${stripped}` : null;
}

function resolveOpencodeSession(body, credentials) {
  return toOpencodeSession(resolveSessionId({
    headers: credentials?.rawHeaders,
    body,
    connectionId: credentials?.connectionId,
    scope: "opencode",
  }));
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
  }

  transformRequest(model, body, stream, credentials) {
    if (credentials) credentials._ocSession = resolveOpencodeSession(body, credentials);
    if (body) {
      body.model = model;
      body.stream = true;
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
    }
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const rt = credentials?.runtimeTransport;
    if (rt?.baseUrl) return rt.urlSuffix ? `${rt.baseUrl}${rt.urlSuffix}` : rt.baseUrl;
    const base = this.config.baseUrl;
    return `${base}/zen/v1/responses`;
  }

  // OpenCode Zen's free tier is rate-limited per real egress IP (daily
  // budget per IP, reset at UTC midnight). There is NO automatic switching:
  // when the current IP's budget is exhausted the gateway answers
  // 429 FreeUsageLimitError and it stays exhausted until midnight — the user
  // picks another node/egress themselves (Clash UI or oc-egress.mjs
  // switch/flip/set) and the SAME conversation continues from the new IP.
  // applyOcEgress() only honors the manually chosen mode from the state file
  // (<APPDATA>/9router/oc-egress.json) so a manual switch works without
  // restarting 9router. Errors propagate untouched.
  async execute(args) {
    applyOcEgress();
    return super.execute(args);
  }

  buildHeaders(credentials, stream = true) {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    const downstreamUa = lower["user-agent"] || "";
    const isOpencodeDownstream = downstreamUa.toLowerCase().includes("opencode");

    // OpenCode Zen's free-tier IP rate limiter reads the x-real-ip request
    // header (ipRateLimiter.ts: rawIp = headers.get("x-real-ip") ?? "" →
    // ip = "unknown"; no header = ONE global bucket shared with every other
    // anonymous client). NOTE: in front of opencode.ai the CDN stamps
    // x-real-ip from the real TCP peer and strips client-supplied values, so
    // this header is best-effort — the reliable per-user isolation comes from
    // real egress IPs (see utils/ocEgress.js). Only real PUBLIC IPs are
    // forwarded: custom-server.js stamps the unspoofable TCP peer as
    // x-9r-real-ip, which is 127.0.0.1 for local clients — forwarding that
    // would put every local 9router user into one shared loopback bucket.
    // For loopback/private peers we fall back to the machine's own public IP.
    const rawIp = (lower["x-9r-real-ip"] || lower["x-real-ip"] || "").trim();
    const clientIp = rawIp && !isPrivateIp(rawIp) ? rawIp : (rawIp ? discoverPublicIp() : "");

    return {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      "User-Agent": isOpencodeDownstream ? downstreamUa : OPENCODE_UA,
      "x-opencode-client": lower["x-opencode-client"] || "desktop",
      "x-opencode-session": lower["x-opencode-session"] || credentials?._ocSession || generateSessionId(),
      "x-opencode-request": lower["x-opencode-request"] || generateRequestId(),
      "x-opencode-project": lower["x-opencode-project"] || "global",
      ...(clientIp ? { "x-real-ip": clientIp } : {}),
      "Accept": stream ? "text/event-stream" : "*/*",
    };
  }
}
