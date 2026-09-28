import { DefaultExecutor } from "./default.js";
import {
  sanitizeChatBody,
  createSseNormalizeTransform,
} from "../protocol/codebuddy/index.js";

/**
 * CodeBuddyExecutor — thin adapter over protocol/codebuddy.
 *
 * Upstream: OpenAI Chat Completions at copilot.tencent.com/v2/chat/completions.
 * Wire rules (allowlist, reasoning gate, stream force, SSE dirt) live in protocol/.
 */
export class CodeBuddyExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-cn");
  }

  transformRequest(model, body, stream, credentials) {
    // DefaultExecutor: json_schema fallback + stripUnsupportedParams + injectReasoningContent
    // (injector is a no-op for this provider). Then protocol allowlist.
    const base = super.transformRequest(model, body, stream, credentials);
    return sanitizeChatBody(base && typeof base === "object" ? base : body);
  }

  async execute(opts) {
    const result = await super.execute(opts);
    if (!result?.response?.ok || !result.response.body) return result;

    const normalized = result.response.body.pipeThrough(createSseNormalizeTransform());
    const response = new Response(normalized, {
      status: result.response.status,
      statusText: result.response.statusText,
      headers: result.response.headers,
    });
    return { ...result, response };
  }
  parseError(response, bodyText) {
    if (bodyText) {
      try {
        const data = JSON.parse(bodyText);
        const msg = data?.msg || data?.message || data?.error?.message || "";
        if (data?.code === 6004 || /超出频率限制|frequency limit|限额/i.test(msg)) {
          let resetsAtMs = null;
          const match = msg.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\s*UTC\+?([0-9:]+))?/i);
          if (match) {
            const dp = match[1];
            const tp = match[2];
            const tz = match[3]
              ? (match[3].includes(":") ? (match[3].startsWith("+") ? match[3] : `+${match[3]}`) : `+${match[3].padStart(2, "0")}:00`)
              : "+08:00";
            const dt = new Date(`${dp}T${tp}${tz}`);
            if (!isNaN(dt.getTime())) resetsAtMs = dt.getTime();
          }
          return {
            status: 429,
            message: msg || "CodeBuddy frequency limit (6004)",
            resetsAtMs,
          };
        }
      } catch {}
    }
    return super.parseError(response, bodyText);
  }
}

