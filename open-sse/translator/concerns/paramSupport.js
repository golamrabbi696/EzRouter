import { getCapabilitiesForModel } from "../../providers/capabilities.js";

// Strip request params a given provider/model rejects upstream (e.g. HTTP 400).
// Config-driven: add a rule instead of scattering `delete body.x` across executors.

// Each rule: optional provider, regex match on model, list of params to drop.
// A param is removed only when it is present (!== undefined).
const STRIP_RULES = [
  // All Claude models: temperature deprecated/rejected upstream (Anthropic 400). #1748
  { match: /claude/i, drop: ["temperature"] },
  // All Claude models: newer Claude Code clients send a top-level `diagnostics`
  // telemetry field gated behind a beta this provider does not advertise, so
  // Anthropic 400s with `diagnostics: Extra inputs are not permitted`.
  { match: /claude/i, drop: ["diagnostics"] },
  // OpenCode Go's Claude lane (/messages) is a strict Anthropic proxy. context_management
  // is SUPPORTED there as long as its beta flag travels with the body (probed: 400 without
  // the flag, 200 + applied_edits with it) — default.js now forwards the client's
  // anthropic-beta for this lane, so that field must NOT be stripped.
  // output_config.task_budget is different: the upstream rejects it even with its own
  // task-budgets-2026-03-13 flag (probed: 400 "Extra inputs are not permitted"), so it has
  // to go. output_config.effort stays — the upstream needs it.
  // Scoped to models whose id contains "claude" — the same unanchored match the
  // temperature rule above uses, and the only OpenCode Go ids that sit on the strict
  // Anthropic lane. Non-Claude ids (deepseek/minimax/glm/kimi…) accept these fields.
  { provider: "opencode-go", match: /claude/i, dropOutputConfigFields: ["task_budget"] },
  // GitHub Copilot GPT-5.4+ and GPT-6.x: temperature unsupported.
  { provider: "github", match: /^gpt-(?:5\.(?:[4-9]|[1-9]\d+)|6\.\d+)(?:-|$)/i, drop: ["temperature"] },
  // GitHub Copilot Claude (except opus/sonnet 4.6): thinking + reasoning_effort rejected. #713
  { provider: "github", match: (m) => /claude/i.test(m) && !/claude.*(opus|sonnet).*4\.6/i.test(m), drop: ["thinking", "reasoning_effort"] },
  // xAI Grok Composer: rejects reasoningEffort entirely (including "none") — omit param upstream.
  { provider: "xai", match: /grok-composer/i, drop: ["thinking", "reasoning_effort", "reasoning"] },
  // Cloudflare Workers AI: content must be plain string, rejects OpenAI content-part array (#1926)
  { provider: "cloudflare-ai", flattenContent: true },
  // OpenCode Muse models: upstream rejects /chat/completions (500) and max_tokens (400),
  // requires Responses API endpoint and no max_tokens / max_completion_tokens.
  { provider: "opencode", match: /muse/i, drop: ["max_tokens", "max_completion_tokens"] },
  // Custom OpenAI-compatible providers (Codex App, etc.) reject reasoning_effort /
  // reasoning — they speak plain OpenAI chat completions without thinking support.
  // Drop them to avoid HTTP 400 "Unsupported parameter: reasoning_effort". #3008
  { provider: /openai-compatible|custom/i, drop: ["reasoning_effort", "reasoning"] },
  { provider: "volcengine-ark", match: /glm-5/i, clampToModelMaxOutput: true },
  // VolcEngine Ark caps the Kimi family at max_tokens <= 32768, but the model's
  // advertised ceiling is far higher (Kimi-K2.7-Code resolves to maxOutput 262144),
  // so clampToModelMaxOutput alone leaves it uncapped and the request 400s with
  // "integer above maximum value, expected <= 32768". Pin an explicit endpoint cap;
  // min() with the model ceiling still applies if a variant's own limit is lower.
  { provider: "volcengine-ark", match: /kimi/i, maxOutputCap: 32768, clampToModelMaxOutput: true },
  // OpenAI gpt-5.x rejects `max_tokens`; it must be `max_completion_tokens`.
  // Rename to avoid HTTP 400 "Unsupported parameter: 'max_tokens'". #2830
  { provider: "openai", match: /gpt-5/i, rename: [["max_tokens", "max_completion_tokens"]] },
  // Strict OpenAI-compatible validators reject unknown assistant-message fields.
  // Clients that talk to reasoning models (e.g. Hermes) echo the prior turn's
  // reasoning back on every assistant message; Groq answers 400 and Mistral 422
  // ("extra_forbidden") on it, which knocks these providers out of every
  // multi-turn combo. Providers that *require* the field (DeepSeek, Kimi) are
  // handled by reasoningContentInjector and are not listed here.
  { provider: "groq", dropMessageFields: ["reasoning_content", "reasoning", "reasoning_details"] },
  { provider: "mistral", dropMessageFields: ["reasoning_content", "reasoning", "reasoning_details"] },
  { provider: "cerebras", dropMessageFields: ["reasoning_content", "reasoning", "reasoning_details"] },
  // OpenCode Go's relay rejects `response_format` for its deepseek family with HTTP
  // 400 — both json_schema and json_object — while glm / kimi / mimo / minimax /
  // qwen / grok / gpt on the same relay accept it. The rejection body is either a
  // bare model echo (`{"model":"deepseek-v4.1-flash"}`, which names neither the
  // field nor the reason) or "This response_format type is unavailable now", so a
  // client cannot classify it and keeps re-sending the field. Measured 2026-10-13
  // against /zen/go/v1/chat/completions with one key: 12/12 structured calls 400,
  // 4/4 identical calls without the field 200.
  { provider: "opencode-go", match: /^deepseek/i, drop: ["response_format"] },
  // DeepSeek's API only documents response_format type json_object; a json_schema
  // request fails with HTTP 400 \"This response_format type is unavailable now\".
  // Downgrade json_schema to json_object and move the schema into a system message
  // so JSON mode is preserved and DeepSeek's \"prompt must mention json\" rule holds.
  { provider: "deepseek", jsonSchemaToObject: true },
  // Current OpenAI models (gpt-5.x / gpt-6.x) reject `max_tokens` with HTTP 400
  // ("Use 'max_completion_tokens' instead"). Clients send `max_tokens`, so rename it.
  { provider: "openai", renameParams: { max_tokens: "max_completion_tokens" } },
];

// Test a rule's match (regex or predicate) against the model id.
function matches(rule, model) {
  if (!rule.match) return true;
  return typeof rule.match === "function" ? rule.match(model) : rule.match.test(model);
}

function clampNumber(body, key, ceiling) {
  if (typeof body[key] === "number" && Number.isFinite(body[key]) && body[key] > ceiling) {
    body[key] = ceiling;
  }
}

function renameParams(body, renames) {
  for (const [from, to] of renames) {
    if (body[from] !== undefined && body[to] === undefined) {
      body[to] = body[from];
      delete body[from];
    }
  }
}

// Remove unsupported params from body in place; returns body.
export function stripUnsupportedParams(provider, model, body) {
  if (!model || !body || typeof body !== "object") return body;

  // Normalize reasoning/reasoning_content alias collision (#4841).
  // When an assistant message contains both reasoning_content and reasoning,
  // upstreams with Rust/serde schemas (z-ai GLM, Moonshot Kimi) fail with
  // HTTP 400 "duplicate field reasoning_content". Keep reasoning_content and drop reasoning.
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg && msg.role === "assistant") {
        if (msg.reasoning_content !== undefined && msg.reasoning !== undefined) {
          delete msg.reasoning;
        }
      }
    }
  }

  for (const rule of STRIP_RULES) {
    if (rule.provider) {
      const pOk = rule.provider instanceof RegExp ? rule.provider.test(provider) : rule.provider === provider;
      if (!pOk) continue;
    }
    if (!matches(rule, model)) continue;
    // Rename params (keeps an explicit target value if the client already sent one).
    for (const [from, to] of Object.entries(rule.renameParams || {})) {
      if (body[from] === undefined) continue;
      if (body[to] === undefined) body[to] = body[from];
      delete body[from];
    }
    // Downgrade response_format json_schema -> json_object for providers that
    // reject json_schema (DeepSeek), preserving JSON mode and carrying the
    // schema over as a system message.
    if (
      rule.jsonSchemaToObject &&
      body.response_format &&
      body.response_format.type === "json_schema"
    ) {
      const s = body.response_format.json_schema || {};
      body.response_format = { type: "json_object" };
      if (Array.isArray(body.messages)) {
        body.messages.unshift({
          role: "system",
          content:
            "Respond only with a JSON object that matches this JSON schema: " +
            JSON.stringify(s.schema || s),
        });
      }
    }
    for (const key of rule.drop || []) {
      if (body[key] !== undefined) delete body[key];
    }
    if (rule.rename) renameParams(body, rule.rename);
    // Nested drops (e.g. output_config.task_budget): keep the rest of the object
    // (effort, format) and drop the container only when it ends up empty — the same
    // shape claude.js uses when it strips output_config.effort. No existing rule
    // declares this key, so the loop is a no-op for every other provider/model.
    for (const key of rule.dropOutputConfigFields || []) {
      if (body.output_config && body.output_config[key] !== undefined) {
        delete body.output_config[key];
        if (Object.keys(body.output_config).length === 0) delete body.output_config;
      }
    }
    // Per-message field drop (assistant turns only — that is where clients replay reasoning).
    if (Array.isArray(rule.dropMessageFields) && Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (!msg || msg.role !== "assistant") continue;
        for (const key of rule.dropMessageFields) {
          if (msg[key] !== undefined) delete msg[key];
        }
      }
    }
    // CF Workers AI oneOf root schema only accepts content as plain string (#1926)
    if (rule.flattenContent && Array.isArray(body.messages)) {
      body.messages = body.messages.filter((msg) => msg && typeof msg.role === "string").map((msg) => {
        const content = Array.isArray(msg.content)
          ? msg.content.map(b => (b?.type === "text" && typeof b.text === "string") ? b.text : "").join("")
          : msg.content;
        return { ...msg, content: typeof content === "string" ? content : "" };
      });
    }
    if (rule.clampToModelMaxOutput || Number.isFinite(rule.maxOutputCap)) {
      const modelCeiling = getCapabilitiesForModel(provider, model).maxOutput;
      const candidates = [];
      if (rule.clampToModelMaxOutput && Number.isFinite(modelCeiling) && modelCeiling > 0) {
        candidates.push(modelCeiling);
      }
      if (Number.isFinite(rule.maxOutputCap) && rule.maxOutputCap > 0) {
        candidates.push(rule.maxOutputCap);
      }
      if (candidates.length > 0) {
        const ceiling = Math.min(...candidates);
        clampNumber(body, "max_tokens", ceiling);
        clampNumber(body, "max_completion_tokens", ceiling);
        clampNumber(body, "max_output_tokens", ceiling);
      }
    }
  }
  return body;
}
