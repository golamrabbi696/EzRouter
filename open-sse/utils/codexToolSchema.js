// Codex-specific tool JSON Schema compatibility.
//
// `https://chatgpt.com/backend-api/codex/responses` validates every function
// tool's `parameters` with stricter JSON Schema handling than some clients.
// Two provider-specific incompatibilities are handled here:
//
// 1. Unicode property escapes in `pattern` are rejected by Codex's regex engine.
// 2. Numeric JSON Schema keywords represented as strings (for example
//    `minItems: "1"` or `default: "1"` for an integer schema) are rejected by
//    Codex's schema validator even though some clients emit them that way.
//
// Scope guardrail: this is NOT a global schema sanitizer. The normalization runs
// only on the Codex dispatch path so other providers keep the caller's schema
// untouched.

// `\p{...}` / `\P{...}` with an odd number of preceding backslashes — an even
// count means the backslash itself is escaped, so `\\p{Cc}` is a literal "p".
const UNICODE_PROPERTY_ESCAPE = /(^|[^\\])(\\\\)*\\[pP]\{/;

const INTEGER_SCHEMA_KEYWORDS = new Set([
  "minLength", "maxLength",
  "minItems", "maxItems",
  "minProperties", "maxProperties",
  "minContains", "maxContains",
]);

const NUMBER_SCHEMA_KEYWORDS = new Set([
  "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum",
  "multipleOf",
]);

export function hasUnicodePropertyEscape(pattern) {
  return typeof pattern === "string" && UNICODE_PROPERTY_ESCAPE.test(pattern);
}

function numericString(value) {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
}

function normalizeNumericKeyword(key, value) {
  if (!numericString(value)) return value;
  const number = Number(value);
  if (INTEGER_SCHEMA_KEYWORDS.has(key)) return Number.isInteger(number) ? number : value;
  if (NUMBER_SCHEMA_KEYWORDS.has(key)) return number;
  return value;
}

function normalizeTypedDefault(node, value) {
  if (!numericString(value)) return value;
  const type = typeof node?.type === "string" ? node.type.toLowerCase() : "";
  const number = Number(value);
  if (type === "integer") return Number.isInteger(number) ? number : value;
  if (type === "number") return number;
  return value;
}

// Copy-on-write walk: returns the original reference when nothing changed, so
// untouched schemas keep object identity and callers can cheaply detect a no-op.
// `properties` is special-cased because its keys are arbitrary property *names*
// (which may themselves be "pattern" or "properties") and must never be read as
// schema keywords; every other key recurses as an ordinary schema node.
function stripNode(node, stats) {
  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((item) => {
      const cleaned = stripNode(item, stats);
      if (cleaned !== item) changed = true;
      return cleaned;
    });
    return changed ? next : node;
  }
  if (!node || typeof node !== "object") return node;

  let changed = false;
  const next = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "pattern" && hasUnicodePropertyEscape(value)) {
      stats.removed++;
      changed = true;
      continue;
    }

    if (key === "default") {
      const normalized = normalizeTypedDefault(node, value);
      if (normalized !== value) {
        changed = true;
        next[key] = normalized;
        continue;
      }
    }

    if (INTEGER_SCHEMA_KEYWORDS.has(key) || NUMBER_SCHEMA_KEYWORDS.has(key)) {
      const normalized = normalizeNumericKeyword(key, value);
      if (normalized !== value) {
        changed = true;
        next[key] = normalized;
        continue;
      }
    }

    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      let propsChanged = false;
      const props = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        const cleaned = stripNode(propSchema, stats);
        if (cleaned !== propSchema) propsChanged = true;
        props[propName] = cleaned;
      }
      if (propsChanged) changed = true;
      next[key] = propsChanged ? props : value;
      continue;
    }

    const cleaned = stripNode(value, stats);
    if (cleaned !== value) changed = true;
    next[key] = cleaned;
  }
  return changed ? next : node;
}

// Remove Codex-incompatible pattern constraints and normalize numeric JSON
// Schema values that Codex requires to be actual numbers.
// Returns the same reference when the schema is already compatible.
export function stripCodexUnsupportedPatterns(schema, stats = { removed: 0 }) {
  return stripNode(schema, stats);
}

// ---------------------------------------------------------------------------
// Shape coercion: legal JSON Schema that is not a valid Schema *object*.
//
// OpenAI's Responses validator walks every function tool's `parameters` and
// requires each property value to be a Schema object. Real MCP tool servers
// emit two shapes that violate this, and one offending parameter fails the
// whole request on every account:
//
//   400 Invalid schema for function 'X': 'object' is not of type 'object', 'boolean'
//   param: tools[71].parameters
//
//   properties: { value: "object" }        — the type name where a Schema belongs
//   items: [{...}, {...}]                  — tuple validation; `items` must be one Schema
//
// Same scope guardrail as stripCodexUnsupportedPatterns: this runs only on the
// Codex dispatch path, and returns the original reference when nothing changed.

// Primitive type names; anything unrecognised degrades to a string (not a
// rejection — the parameter stays usable).
const JSON_SCHEMA_TYPES = new Set([
  "string", "number", "integer", "boolean", "array", "object", "null"
]);

function isSchemaObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function schemaFromTypeHint(value) {
  const hint = typeof value === "string" ? value.trim() : "";
  return { type: JSON_SCHEMA_TYPES.has(hint) ? hint : "string" };
}

// Codex cannot express tuples either — keep the most informative member.
// Mirrors the Antigravity translator's selectBest() scoring.
function selectBestVariant(variants) {
  let best = variants[0];
  let bestScore = -1;
  for (const item of variants) {
    let score = 0;
    if (item.type === "object" || item.properties) score = 3;
    else if (item.type === "array" || item.items) score = 2;
    else if (item.type && item.type !== "null") score = 1;
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}

function coerceNode(node) {
  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((item) => {
      const coerced = coerceNode(item);
      if (coerced !== item) changed = true;
      return coerced;
    });
    return changed ? next : node;
  }
  if (!node || typeof node !== "object") return node;

  let changed = false;
  const next = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "items") {
      if (Array.isArray(value)) {
        const variants = value.filter(isSchemaObject);
        changed = true;
        if (variants.length > 0) next[key] = coerceNode(selectBestVariant(variants));
        continue;
      }
      if (typeof value === "string") {
        changed = true;
        next[key] = schemaFromTypeHint(value);
        continue;
      }
    }
    // Property names are arbitrary data (a tool may declare a `properties`
    // parameter), so they must never be read as schema keywords.
    if (key === "properties" && isSchemaObject(value)) {
      let propsChanged = false;
      const props = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        const coerced = isSchemaObject(propSchema)
          ? coerceNode(propSchema)
          : schemaFromTypeHint(propSchema);
        if (coerced !== propSchema) propsChanged = true;
        props[propName] = coerced;
      }
      if (propsChanged) changed = true;
      next[key] = propsChanged ? props : value;
      continue;
    }
    const coerced = coerceNode(value);
    if (coerced !== value) changed = true;
    next[key] = coerced;
  }
  return changed ? next : node;
}

// Coerce schema shapes the Codex Responses validator rejects.
// Returns the same reference when the schema is already compatible.
export function coerceCodexSchemaShapes(schema) {
  return coerceNode(schema);
}
