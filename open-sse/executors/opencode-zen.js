import crypto from "node:crypto";
import { MAX_TOOL_NAME_LEN } from "../config/appConstants.js";
import { DefaultExecutor } from "./default.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { isMuseSparkModel, isOpencodeFreeTierModel } from "../providers/models/helpers.js";
import { readToolStrict, restoreToolStrict } from "../translator/concerns/toolStrict.js";
import {
  normalizeResponsesInput,
  clampResponsesCallId,
  coerceResponsesArguments,
  coerceResponsesOutput,
} from "../translator/formats/responsesApi.js";

const SESSION_HEADER = "x-opencode-session";
const SESSION_FIELD = "_opencodeZenSession";
const REQ_FIELD = "_opencodeZenRequest";
const MAX_SESSION_LENGTH = 256;

const RESPONSES_BASE_URL = "https://opencode.ai/zen/v1/responses";
// Console rejects max_output_tokens < 16 with 400 invalid_request_error.
const MIN_OUTPUT_TOKENS = 16;
const MAX_TOOL_NAME_LEN = 128;
const OPENCODE_UA = "opencode/latest/2.0.29/cli";
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
export const OPENCODE_REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
// Free-tier fingerprint (mirrors opencode executor, PR #4132): upstream 403s
// requests without the file-search quartet and without stream:true.
const OPENCODE_FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"];

// Upstream validates the session id itself, not just its shape: the 12-hex
// prefix must decode to a recent timestamp (~(now*0x1000+1), like the real
// CLI mints). Hash-translated sessions (translateSessionId) carry no time and
// answer 403 FreeTierError even with otherwise perfect attestation. Free-tier
// models therefore need a stable TIME-based session per downstream identity —
// stable because minting a fresh session per request burns free-tier quota
// into 429 FreeUsageLimitError, mirroring the real CLI's one session per
// conversation.
const stableFreeTierSessions = new Map();
const MAX_STABLE_FREE_TIER_SESSIONS = 1000;

function freeTierIdentityKey(credentials) {
  const connectionId = credentials?.connectionId || credentials?.id;
  if (connectionId) return `opencode-zen:conn:${String(connectionId).slice(0, 128)}`;
  const raw = credentials?.rawHeaders || {};
  const auth = raw.authorization || raw.Authorization || raw["x-api-key"] || raw["X-Api-Key"] || "";
  if (auth) {
    const digest = crypto.createHash("sha256").update(String(auth)).digest("hex").slice(0, 32);
    return `opencode-zen:auth:${digest}`;
  }
  return "opencode-zen:default";
}

export function stableFreeTierSessionId(credentials) {
  const key = freeTierIdentityKey(credentials);
  const existing = stableFreeTierSessions.get(key);
  if (existing) {
    stableFreeTierSessions.delete(key);
    stableFreeTierSessions.set(key, existing);
    return existing;
  }
  const sessionId = generateSessionId();
  if (stableFreeTierSessions.size >= MAX_STABLE_FREE_TIER_SESSIONS) {
    stableFreeTierSessions.delete(stableFreeTierSessions.keys().next().value);
  }
  stableFreeTierSessions.set(key, sessionId);
  return sessionId;
}

function hasValidOpencodeVersion(ua) {
  // Accept both legacy "opencode/1.18.31" and channel form
  // "opencode/latest/2.0.29/cli" (official CLI since 2.0, issue #4837/#4861).
  const legacy = String(ua || "").match(/opencode\/(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (legacy) {
    const major = parseInt(legacy[1], 10);
    const minor = parseInt(legacy[2], 10);
    return major > 1 || (major === 1 && minor >= 17);
  }
  const channel = String(ua || "").match(/opencode\/[a-z-]+\/(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (channel) {
    const major = parseInt(channel[1], 10);
    const minor = parseInt(channel[2], 10);
    return major > 1 || (major === 1 && minor >= 17);
  }
  return false;
}

function unstableRandom() {
  const bytes = crypto.randomBytes(14);
  let randomPart = "";
  for (let i = 0; i < 14; i++) {
    randomPart += BASE62_CHARS[bytes[i] % 62];
  }
  return randomPart;
}

// Session prefix = 12 hex of ~(timeMs * 0x1000 + counter), low 48 bits, like the CLI.
// Upstream decodes it and rejects a non-small counter with 403 FreeTierError
// (live probes: counter 0–16 pass, >=100 fail), so the counter must stay real.
const SESSION_PREFIX_MASK = (1n << 48n) - 1n;
const SESSION_TIME_MASK = (1n << 36n) - 1n;

function descendingTimeHex(time, counterValue) {
  return (~(BigInt(time) * 0x1000n + BigInt(counterValue)) & SESSION_PREFIX_MASK)
    .toString(16)
    .padStart(12, "0");
}

export function generateSessionId(timestamp = Date.now()) {
  return `ses_${descendingTimeHex(timestamp, 1)}${unstableRandom()}`;
}

export function generateRequestId(timestamp = Date.now()) {
  const current = BigInt(timestamp) * 0x1000n + 1n;
  const value = current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");
  return `msg_${time}${unstableRandom()}`;
}

export function deriveRequestId(sessionId, text) {
  if (!text) return generateRequestId();
  const digest = crypto
    .createHash("sha256")
    .update(`opencode-req\0${sessionId || ""}\0${text}`)
    .digest();
  const timeHex = digest.subarray(0, 6).toString("hex");
  let randomPart = "";
  for (let i = 6; i < 20; i++) {
    randomPart += BASE62_CHARS[digest[i] % 62];
  }
  const id = `msg_${timeHex}${randomPart}`;
  return OPENCODE_REQUEST_RE.test(id) ? id : generateRequestId();
}

export function lastUserText(body) {
  try {
    if (!body || typeof body !== "object") return "";
    const arr = Array.isArray(body.messages)
      ? body.messages
      : Array.isArray(body.input)
        ? body.input
        : null;
    if (!arr) return typeof body.input === "string" ? body.input.slice(-600) : "";
    for (let i = arr.length - 1; i >= 0; i--) {
      const msg = arr[i];
      if (!msg) continue;
      if (msg.role && msg.role !== "user") continue;
      const content = msg.content;
      if (typeof content === "string" && content.trim()) return content.trim().slice(-600);
      if (Array.isArray(content)) {
        const text = content
          .map((part) => (typeof part === "string" ? part : part?.text || part?.input_text || ""))
          .join(" ")
          .trim();
        if (text) return text.slice(-600);
      }
    }
  } catch {
    return "";
  }
  return "";
}

export function translateSessionId(sessionId, clientTool = "") {
  if (typeof sessionId === "string" && OPENCODE_SESSION_RE.test(sessionId.trim())) {
    return sessionId.trim();
  }
  const digest = crypto
    .createHash("sha256")
    .update(`opencode\0${clientTool || "generic"}\0${sessionId || ""}`)
    .digest();
  // Deterministic time field from the digest, counter pinned to 1 (what the CLI sends).
  const time = BigInt(`0x${digest.subarray(0, 5).toString("hex")}`) & SESSION_TIME_MASK;
  const timeHex = descendingTimeHex(time, 1);
  let randomPart = "";
  for (let i = 6; i < 20; i++) {
    randomPart += BASE62_CHARS[digest[i] % 62];
  }
  return `ses_${timeHex}${randomPart}`;
}

function toolNameOf(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
  const raw = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
  return raw.trim();
}

function ensureChatFingerprintTools(body) {
  if (!body || typeof body !== "object") return;
  const present = new Set();
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      const name = toolNameOf(tool);
      if (name) present.add(name);
    }
  } else {
    body.tools = [];
  }
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (present.has(name)) continue;
    body.tools.push({
      type: "function",
      function: {
        name,
        description: `OpenCode built-in ${name} tool`,
        parameters: { type: "object", properties: {} },
      },
    });
    present.add(name);
  }
}

function ensureResponsesFingerprintTools(body) {
  if (!body || typeof body !== "object") return;
  const present = new Set();
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      const name = toolNameOf(tool);
      if (name) present.add(name);
    }
  } else {
    body.tools = [];
  }
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (present.has(name)) continue;
    body.tools.push({
      type: "function",
      name,
      description: `OpenCode built-in ${name} tool`,
      parameters: { type: "object", properties: {} },
    });
    present.add(name);
  }
}

function normalizeSession(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_LENGTH) return null;
  return normalized;
}

function nativeSession(headers) {
  if (!headers || typeof headers !== "object") return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      const normalized = normalizeSession(value);
      if (normalized && OPENCODE_SESSION_RE.test(normalized)) return normalized;
    }
  }
  return null;
}

function translatedSession(sessionId, clientTool) {
  return translateSessionId(sessionId, clientTool);
}

// Strip the thinking suffix "model(level)" so checks hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  return isMuseSparkModel(baseModelId(model));
}

// Flatten Chat Completions tool declarations into the Responses flat shape and
// drop hosted/nameless tools the /responses endpoint rejects.
function normalizeResponsesTools(body) {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set();
  body.tools = body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
    const rawName = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
    const name = rawName.trim();
    if (!name) return false;
    const description = typeof tool.description === "string" ? tool.description : (typeof fn?.description === "string" ? fn.description : "");
    let parameters = (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters))
      ? tool.parameters
      : (fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters) ? fn.parameters : { type: "object", properties: {} });
    // Mirror the request translator: {type:"object"} without properties is rejected
    // by strict Responses backends, so fill in the empty properties map.
    if (parameters.type === "object" && !parameters.properties) parameters = { ...parameters, properties: {} };
    // Keep the client-declared strict: omitted means strict-normalized on Responses.
    const strict = readToolStrict(tool);
    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = "function";
    tool.name = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_TOOL_NAME_LEN);
    if (description) tool.description = description;
    tool.parameters = parameters;
    restoreToolStrict(tool, strict);
    validNames.add(tool.name);
    return true;
  });
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    if (body.tool_choice.type === "function") {
      const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
      // validNames holds CLAMPED names; a tool_choice still carrying the original
      // would not match and would be dropped, silently turning a forced tool call
      // into an unforced one. Compare and rewrite against the clamped form.
      const clamped = n.slice(0, MAX_TOOL_NAME_LEN);
      if (!n || (!validNames.has(n) && !validNames.has(clamped))) delete body.tool_choice;
      else body.tool_choice.name = clamped;
    }
  }
}

// Last line of defense for native Responses clients (sourceFormat === targetFormat
// skips translation): coerce items in place so malformed tool payloads 400 here
// with a clear shape instead of upstream as InputValidationError.
function sanitizeResponsesItems(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    // Strip prior-turn reasoning items: Muse Spark contributor models route to
    // an upstream Console backend where encrypted_content cannot be validated across
    // rotated accounts or sessions, causing 400 "reasoning encrypted_content was not issued to this caller".
    if (item.type === "reasoning") return false;
    delete item.encrypted_content;
    delete item.reasoning_encrypted_content;
    if (item.type === "function_call") {
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") return false;
      item.name = item.name.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_TOOL_NAME_LEN);
      item.call_id = clampResponsesCallId(item.call_id);
      item.arguments = coerceResponsesArguments(item.arguments);
      return true;
    }
    if (item.type === "function_call_output") {
      item.call_id = clampResponsesCallId(item.call_id);
      item.output = coerceResponsesOutput(item.output);
      return true;
    }
    return true;
  });
  const callIds = new Set(body.input.filter((x) => x?.type === "function_call").map((x) => x.call_id));
  body.input = body.input.filter((x) => x?.type !== "function_call_output" || callIds.has(x.call_id));
  const outputIds = new Set(body.input.filter((x) => x?.type === "function_call_output").map((x) => x.call_id));
  const paired = [];
  for (const item of body.input) {
    paired.push(item);
    if (item?.type === "function_call" && !outputIds.has(item.call_id)) {
      paired.push({ type: "function_call_output", call_id: item.call_id, output: "{}" });
      outputIds.add(item.call_id);
    }
  }
  body.input = paired;
}

export class OpenCodeZenExecutor extends DefaultExecutor {
  constructor() {
    super("opencode-zen");
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    // Muse Spark lives on /responses even when a stale runtimeTransport leaks in.
    if (isResponsesModel(model)) return RESPONSES_BASE_URL;
    return super.buildUrl(model, stream, urlIndex, credentials);
  }

  prepareRequestCredentials({ body, credentials, providerSessionId, clientTool } = {}) {
    const sourceCredentials = credentials || {};
    const native = nativeSession(sourceCredentials.rawHeaders);
    const resolved = normalizeSession(providerSessionId) || resolveSessionId({
      headers: sourceCredentials.rawHeaders,
      body,
      connectionId: sourceCredentials.connectionId,
      scope: "opencode-zen",
    });

    const sessionId = native || translatedSession(resolved, clientTool);
    const lower = {};
    for (const [k, v] of Object.entries(sourceCredentials.rawHeaders || {})) lower[k.toLowerCase()] = v;
    const downstreamReq = lower["x-opencode-request"];

    return {
      ...sourceCredentials,
      [SESSION_FIELD]: sessionId,
      [REQ_FIELD]: downstreamReq || deriveRequestId(sessionId, lastUserText(body)),
    };
  }

  async execute(args) {
    const credentials = this.prepareRequestCredentials(args);
    return super.execute({ ...args, credentials });
  }

  buildHeaders(credentials, stream = true, url, model) {
    const headers = super.buildHeaders(credentials || {}, stream, url, model);
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;
    const downstreamUa = lower["user-agent"] || "";
    // Free-tier gate: spoof the official client UA.
    headers["User-Agent"] = hasValidOpencodeVersion(downstreamUa) ? downstreamUa : OPENCODE_UA;
    headers["x-opencode-client"] = lower["x-opencode-client"] || "desktop";
    headers["x-opencode-project"] = lower["x-opencode-project"] || "global";
    const prepared = credentials?.[SESSION_FIELD];
    if (prepared) {
      headers[SESSION_HEADER] = prepared;
    } else {
      const fallback = this.prepareRequestCredentials({ credentials });
      headers[SESSION_HEADER] = fallback[SESSION_FIELD];
    }

    const preparedReq = credentials?.[REQ_FIELD];
    if (preparedReq && !credentials?.apiKey) {
      headers["x-opencode-request"] = preparedReq;
    }

    if (isOpencodeFreeTierModel(model)) {
      // Free-tier models are gated behind the attested free-tier identity even
      // on the keyed lane: a real oc_sk_* key answers 403 FreeTierError, while
      // `Bearer public` + session/request ids succeed. Paid models keep the
      // connection key untouched. The session must be time-based (see
      // stableFreeTierSessionId): hash-translated sessions 403.
      headers["Authorization"] = "Bearer public";
      headers[SESSION_HEADER] = stableFreeTierSessionId(credentials);
      headers["x-opencode-request"] = generateRequestId();
    } else if (raw["x-opencode-request"]) {
      headers["x-opencode-request"] = raw["x-opencode-request"];
    } else {
      delete headers["x-opencode-request"];
    }
    return headers;
  }

  transformRequest(model, body, stream, credentials) {
    const out = super.transformRequest(model, body);
    // Free-tier gate: upstream 403s stream:false even when everything else is valid.
    if (out && typeof out === "object") out.stream = true;
    if (!isResponsesModel(model || body?.model)) {
      ensureChatFingerprintTools(out);
      return out;
    }
    const normalized = normalizeResponsesInput(out.input);
    if (normalized) out.input = normalized;
    if (!Array.isArray(out.input) || out.input.length === 0) {
      out.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
    }
    // Responses names the output cap max_output_tokens, not max_tokens.
    if (out.max_output_tokens === undefined) {
      if (out.max_completion_tokens !== undefined) out.max_output_tokens = out.max_completion_tokens;
      else if (out.max_tokens !== undefined) out.max_output_tokens = out.max_tokens;
    }
    // Floor at the provider minimum: tiny model-switch probes (e.g. Claude
    // Code checks a model with max_tokens: 1) would otherwise 400 and the
    // client refuses to switch to the model.
    if (out.max_output_tokens !== undefined) {
      out.max_output_tokens = Math.max(MIN_OUTPUT_TOKENS, Number(out.max_output_tokens) || MIN_OUTPUT_TOKENS);
    }
    delete out.max_tokens;
    delete out.max_completion_tokens;
    if (typeof out.max_output_tokens === "number") {
      out.max_output_tokens = Math.min(Math.max(out.max_output_tokens, 16), 65536);
    }
    if (out.reasoning_effort !== undefined && out.reasoning === undefined) {
      out.reasoning = { effort: out.reasoning_effort, summary: "auto" };
    }
    if (out.reasoning && typeof out.reasoning === "object" && !Array.isArray(out.reasoning)) {
      if (!out.reasoning.summary) out.reasoning.summary = "auto";
    }
    delete out.reasoning_effort;
    out.stream = true;
    out.store = false;
    ensureResponsesFingerprintTools(out);
    normalizeResponsesTools(out);
    sanitizeResponsesItems(out);
    return out;
  }
}
