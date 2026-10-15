// Gemini helper functions for translator

import { safeParseJSON } from "../concerns/json.js";
import { OPENAI_BLOCK } from "../schema/index.js";
import { isGemini4Model } from "../../providers/capabilities.js";

// Unsupported JSON Schema constraints that should be removed for Antigravity
export const UNSUPPORTED_SCHEMA_CONSTRAINTS = [
  // Basic constraints (not supported by Gemini API)
  "minLength", "maxLength", "exclusiveMinimum", "exclusiveMaximum",
  "minItems", "maxItems", "format", "multipleOf",
  // Array keywords the Gemini schema proto has no field for. Agent tool
  // schemas set these routinely, and one occurrence rejects the whole request
  // with "Unknown name ...: Cannot find field".
  "uniqueItems", "contains",
  // 2020-12 keywords with no Gemini equivalent
  "unevaluatedProperties", "unevaluatedItems", "contentSchema",
  // Tuple-array keywords; converted to items first, leftovers stripped
  "prefixItems", "additionalItems",
  // Claude rejects these in VALIDATED mode
  "default", "examples", "example",
  // JSON Schema meta keywords
  "$schema", "$defs", "definitions", "const", "$ref", "$comment", "$id",
  // Annotation keywords (rejected by Gemini/Antigravity - e.g. MCP tool schemas set these)
  "deprecated", "readOnly", "writeOnly",
  // Object validation keywords (not supported)
  "additionalProperties", "propertyNames", "patternProperties", "enumDescriptions", "strict",
  // Complex schema keywords (handled by flattenAnyOfOneOf/mergeAllOf)
  "anyOf", "oneOf", "allOf", "not",
  // Dependency keywords (not supported)
  "dependencies", "dependentSchemas", "dependentRequired",
  // Other unsupported keywords
  "title", "optional", "if", "then", "else", "contentMediaType", "contentEncoding",
  // Vendor-specific extensions from OpenAI / Anthropic / MCP / Cursor
  "encrypted", "cache_control",
  // UI/Styling properties (from Cursor tools - NOT JSON Schema standard)
  "cornerRadius", "fillColor", "fontFamily", "fontSize", "fontWeight",
  "gap", "padding", "strokeColor", "strokeThickness", "textColor",
  // Non-standard annotation/error keywords used by some MCP tool schemas (#4283).
  // Gemini's schema proto has no field for these and rejects the whole request with
  // "Unknown name X: Cannot find field" if any nested schema node carries them.
  "errorMessage", "errorMessages", "x-errorMessage", "x-errorMessages",
  "markdownDescription", "x-intellij-html-description",
  "x-taplo-info", "x-taplo", "doNotSuggest", "suggestSortText",
  "minProperties", "maxProperties",
  // Codex connector tools annotate sensitive arguments with this extension.
  // It is metadata, not a field supported by Gemini's Schema proto.
  "encrypted"
];

// Non-schema stray keys sometimes left by sloppy converters at a schema node
// (e.g. `value: "object"` next to `type`/`properties`). They are never valid
// JSON Schema keywords, but they ARE valid property names inside a name-map, so
// they must only be stripped at schema nodes, never in `properties` maps
// (issue #2902).
const STRAY_SCHEMA_KEYS = new Set(["value"]);

// Default safety settings
export const DEFAULT_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" }
];

// Convert OpenAI content to Gemini parts
export function convertOpenAIContentToParts(content) {
  const parts = [];

  if (typeof content === "string") {
    parts.push({ text: content });
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === OPENAI_BLOCK.TEXT) {
        parts.push({ text: item.text });
      } else if (item.type === OPENAI_BLOCK.IMAGE_URL && item.image_url?.url?.startsWith("data:")) {
        const url = item.image_url.url;
        const commaIndex = url.indexOf(",");
        if (commaIndex !== -1) {
          const mimePart = url.substring(5, commaIndex); // skip "data:"
          const data = url.substring(commaIndex + 1);
          const mimeType = mimePart.split(";")[0];

          parts.push({
            inlineData: { mime_type: mimeType, data: data }
          });
        }
      } else if (item.type === OPENAI_BLOCK.IMAGE_URL && item.image_url?.url && (item.image_url.url.startsWith("http://") || item.image_url.url.startsWith("https://"))) {
        parts.push({
          fileData: { fileUri: item.image_url.url, mimeType: "image/*" }
        });
      } else if (item.type === OPENAI_BLOCK.INPUT_AUDIO && item.input_audio?.data) {
        const format = item.input_audio.format || "wav";
        const mimeType = format === "mp3" ? "audio/mpeg" : `audio/${format}`;
        parts.push({
          inlineData: { mime_type: mimeType, data: item.input_audio.data }
        });
      } else if (item.type === OPENAI_BLOCK.AUDIO_URL && item.audio_url?.url?.startsWith("data:")) {
        const url = item.audio_url.url;
        const commaIndex = url.indexOf(",");
        if (commaIndex !== -1) {
          const mimePart = url.substring(5, commaIndex);
          const data = url.substring(commaIndex + 1);
          const mimeType = mimePart.split(";")[0];
          parts.push({
            inlineData: { mime_type: mimeType, data: data }
          });
        }
      } else if (item.type === OPENAI_BLOCK.FILE && item.file?.file_data?.startsWith("data:")) {
        const url = item.file.file_data;
        const commaIndex = url.indexOf(",");
        if (commaIndex !== -1) {
          const mimeType = url.substring(5, commaIndex).split(";")[0];
          const data = url.substring(commaIndex + 1);
          parts.push({ inlineData: { mime_type: mimeType, data: data } });
        }
      }
    }
  }

  return parts;
}

// Extract text content from OpenAI content
export function extractTextContent(content, separator = "") {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter(c => c.type === OPENAI_BLOCK.TEXT).map(c => c.text).join(separator);
  }
  return "";
}

// Sanitize parsed JSON keys for Gemini function response
// Gemini rejects keys starting with $, #, /, or definitions because they get parsed as protobuf schema references
export function sanitizeFunctionResponseResult(val) {
  if (val && typeof val === "object") {
    if (Array.isArray(val)) {
      return val.map(sanitizeFunctionResponseResult);
    }
    const out = {};
    for (let [k, v] of Object.entries(val)) {
      if (k.startsWith("$") || k === "definitions" || k.includes("/") || k.includes("#")) {
        k = k.replace(/^[$#\/]+/, "_").replace(/[\/#$]/g, "_");
      }
      out[k] = sanitizeFunctionResponseResult(v);
    }
    return out;
  }
  return val;
}

// Try parse JSON safely and sanitize keys for Gemini compatibility
export function tryParseJSON(str) {
  const parsed = safeParseJSON(str, null);
  return parsed !== null ? sanitizeFunctionResponseResult(parsed) : null;
}

// Generate request ID
export function generateRequestId() {
  return `agent-${crypto.randomUUID()}`;
}

// Generate session ID (binary-compatible format: UUID + timestamp)
export function generateSessionId() {
  return crypto.randomUUID() + Date.now().toString();
}

// Generate project ID
export function generateProjectId() {
  const adjectives = ["useful", "bright", "swift", "calm", "bold"];
  const nouns = ["fuze", "wave", "spark", "flow", "core"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj}-${noun}-${crypto.randomUUID().slice(0, 5)}`;
}

// Visit schemas, never property-name dictionaries or literal annotation/enum data.
function forEachSubschema(obj, visit) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const schema of obj) visit(schema);
    return;
  }
  for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
    const map = obj[key];
    if (map && typeof map === "object" && !Array.isArray(map)) {
      for (const schema of Object.values(map)) visit(schema);
    }
  }
  for (const key of ["items", "additionalItems", "contains", "additionalProperties", "propertyNames", "not", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems", "contentSchema"]) {
    const schema = obj[key];
    if (Array.isArray(schema)) {
      for (const item of schema) visit(item);
    } else if (schema && typeof schema === "object") {
      visit(schema);
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    if (Array.isArray(obj[key])) {
      for (const schema of obj[key]) visit(schema);
    }
  }
}

// Helper: Remove unsupported keywords from schema nodes
// Also strips all vendor extension fields (x- prefixed) not supported by Gemini
function removeUnsupportedKeywords(obj, keywords) {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      removeUnsupportedKeywords(item, keywords);
    }
    return;
  }

  // Strip stray non-schema keys (e.g. `value`) only at real schema nodes —
  // a node is a schema when it has type/properties/items; inside a property
  // name-map `value` is a legitimate user parameter name (issue #2902/#2884).
  const isSchemaNode = obj.type !== undefined || obj.properties !== undefined || obj.items !== undefined;

  for (const key of Object.keys(obj)) {
    if (isSchemaNode && STRAY_SCHEMA_KEYS.has(key)) {
      delete obj[key];
      continue;
    }
    if (keywords.includes(key) || key.startsWith("x-")) {
      delete obj[key];
      continue;
    }
  }

  forEachSubschema(obj, schema => removeUnsupportedKeywords(schema, keywords));
}

// Convert const to enum
function convertConstToEnum(obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.const !== undefined && !obj.enum) {
    obj.enum = [obj.const];
    delete obj.const;
  }

  forEachSubschema(obj, convertConstToEnum);
}

// Convert enum values to strings (Gemini requires string enum values + explicit type:"string")
function convertEnumValuesToStrings(obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.enum && Array.isArray(obj.enum)) {
    obj.enum = obj.enum.map(v => String(v));
    // Gemini API requires type:"string" when enum is present — without it returns 400
    if (!obj.type) {
      obj.type = "string";
    }
  }

  forEachSubschema(obj, convertEnumValuesToStrings);
}

// Merge allOf schemas
function mergeAllOf(obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.allOf && Array.isArray(obj.allOf)) {
    const merged = {};

    for (const item of obj.allOf) {
      if (item.properties) {
        if (!merged.properties) merged.properties = {};
        Object.assign(merged.properties, item.properties);
      }
      if (item.required && Array.isArray(item.required)) {
        if (!merged.required) merged.required = [];
        for (const req of item.required) {
          if (!merged.required.includes(req)) {
            merged.required.push(req);
          }
        }
      }
    }

    delete obj.allOf;
    if (merged.properties) obj.properties = { ...obj.properties, ...merged.properties };
    if (merged.required) obj.required = [...(obj.required || []), ...merged.required];
  }

  forEachSubschema(obj, mergeAllOf);
}

// Select best schema from anyOf/oneOf
function selectBest(items) {
  let bestIdx = 0;
  let bestScore = -1;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let score = 0;
    const type = item.type;

    if (type === "object" || item.properties) {
      score = 3;
    } else if (type === "array" || item.items) {
      score = 2;
    } else if (type && type !== "null") {
      score = 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestIdx;
}

// Flatten anyOf/oneOf
function flattenAnyOfOneOf(obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.anyOf && Array.isArray(obj.anyOf) && obj.anyOf.length > 0) {
    const nonNullSchemas = obj.anyOf.filter(s => s && s.type !== "null");
    if (nonNullSchemas.length > 0) {
      const bestIdx = selectBest(nonNullSchemas);
      const selected = nonNullSchemas[bestIdx];
      delete obj.anyOf;
      Object.assign(obj, selected);
    }
  }

  if (obj.oneOf && Array.isArray(obj.oneOf) && obj.oneOf.length > 0) {
    const nonNullSchemas = obj.oneOf.filter(s => s && s.type !== "null");
    if (nonNullSchemas.length > 0) {
      const bestIdx = selectBest(nonNullSchemas);
      const selected = nonNullSchemas[bestIdx];
      delete obj.oneOf;
      Object.assign(obj, selected);
    }
  }

  forEachSubschema(obj, flattenAnyOfOneOf);
}

// Flatten type arrays
function flattenTypeArrays(obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.type && Array.isArray(obj.type)) {
    const nonNullTypes = obj.type.filter(t => t !== "null");
    obj.type = nonNullTypes.length > 0 ? nonNullTypes[0] : "string";
  }

  forEachSubschema(obj, flattenTypeArrays);
}

// Infer missing type=object when properties exist (Gemini requires explicit type).
// Descends only into schema nodes — the property name-map is NOT a schema node,
// so a parameter literally named "properties" must not get a bogus type injected
// (issue #2884).
function ensureObjectType(obj) {
  if (!obj || typeof obj !== "object") return;
  if (obj.properties && !obj.type) obj.type = "object";
  forEachSubschema(obj, ensureObjectType);
}

// Convert prefixItems (tuple validation) to items — Gemini cannot express tuples,
// and a type:"array" schema without items is rejected with "missing field"
function convertPrefixItems(obj) {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj.prefixItems) && obj.prefixItems.length > 0) {
    const variants = obj.prefixItems.filter(s => s && s.type !== "null");
    if (!obj.items && variants.length === 1) {
      obj.items = variants[0];
    } else if (!obj.items && variants.length > 1) {
      obj.items = { anyOf: variants };
    }
    delete obj.prefixItems;
  }

  // Handle draft 4/7 tuple validation where items is an array
  if (Array.isArray(obj.items)) {
    const variants = obj.items.filter(s => s && s.type !== "null");
    if (variants.length === 1) {
      obj.items = variants[0];
    } else if (variants.length > 1) {
      obj.items = { anyOf: variants };
    } else {
      obj.items = { type: "string" };
    }
  }

  forEachSubschema(obj, convertPrefixItems);
}

// Gemini requires items on every type:"array" schema — fill a permissive placeholder
function ensureArrayItems(obj) {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const v of obj) ensureArrayItems(v);
    return;
  }

  // Infer array type if items exists without explicit type
  if (obj.items && !obj.type) {
    obj.type = "array";
  }

  if (obj.type === "array") {
    // 1. If items is an Array (tuple validation)
    if (Array.isArray(obj.items)) {
      const nonNull = obj.items.filter(s => s && s.type !== "null");
      if (nonNull.length === 0) {
        obj.items = { type: "string" };
      } else if (nonNull.length === 1) {
        obj.items = nonNull[0];
      } else {
        const bestIdx = selectBest(nonNull);
        obj.items = nonNull[bestIdx];
      }
    }

    // 2. If items is missing or not an object
    if (!obj.items || typeof obj.items !== "object") {
      obj.items = { type: "string" };
    }

    // 3. If items is an empty object or lacks a type
    if (!obj.items.type || Object.keys(obj.items).length === 0) {
      if (obj.items.properties) {
        obj.items.type = "object";
      } else if (obj.items.items) {
        obj.items.type = "array";
      } else {
        obj.items.type = "string";
      }
    }
  }

  forEachSubschema(obj, ensureArrayItems);
}

// JSON Schema primitive type names Gemini's Schema proto understands.
const JSON_SCHEMA_TYPES = new Set([
  "string", "number", "integer", "boolean", "array", "object", "null"
]);

function isSchemaObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// A bare type name used where a Schema is expected means "any value of this
// type"; anything unrecognised degrades to a string.
function schemaFromTypeHint(value) {
  const hint = typeof value === "string" ? value.trim() : "";
  return { type: JSON_SCHEMA_TYPES.has(hint) ? hint : "string" };
}

// Expand shorthand string schemas into real Schema objects.
//
// JSON Schema requires every subschema to be an object, but agent and MCP tool
// definitions routinely use the shorthand `{ value: "object" }` for
// `{ value: { type: "object" } }`. Gemini's proto has no union for this and
// rejects the whole request:
//   Invalid value at 'tools[0].function_declarations[N].parameters
//   .properties[M].value' (...Schema), "object"
//
// Every other pass here recurses only into `typeof x === "object"`, so a string
// subschema is invisible to them — this must run first, and must rewrite the
// parent's slot rather than the (primitive, unmodifiable) value itself.
const SCHEMA_SLOTS = ["items", "additionalItems", "contains", "if", "then", "else", "not", "propertyNames", "unevaluatedItems", "contentSchema"];
const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];

function expandStringSchemas(obj) {
  if (!obj || typeof obj !== "object") return;

  const expand = (value) => (typeof value === "string" ? schemaFromTypeHint(value) : value);

  for (const slot of SCHEMA_SLOTS) {
    if (typeof obj[slot] === "string") obj[slot] = expand(obj[slot]);
  }

  for (const mapKey of SCHEMA_MAPS) {
    const map = obj[mapKey];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const [key, value] of Object.entries(map)) {
      if (typeof value === "string") map[key] = expand(value);
    }
  }

  // `additionalProperties: false` is a valid boolean and is stripped later;
  // only a string form is shorthand for a schema.
  if (typeof obj.additionalProperties === "string") {
    obj.additionalProperties = expand(obj.additionalProperties);
  }

  forEachSubschema(obj, expandStringSchemas);
}

// Mirror of selectBest(): keep the most informative member of a tuple.
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

// Normalize the two shapes that are legal JSON Schema but that Gemini's Schema
// proto cannot represent. Real MCP tool servers emit both, so a single offending
// parameter rejects the whole request:
//
//   Invalid value at '…function_declarations[71].parameters.properties[9].value'
//     (type.googleapis.com/google.cloud.aiplatform.master.Schema), "object"   (#2877, #2489)
//   Unknown name "items" at '…parameters.properties[0].value':
//     Proto field is not repeating, cannot start list.                        (tuple `items`)
//
// `properties` is special-cased because its keys are arbitrary property *names*
// and must never be read as schema keywords.
function normalizeSchemaValueShapes(obj) {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) normalizeSchemaValueShapes(item);
    return;
  }

  if (Array.isArray(obj.items)) {
    const variants = obj.items.filter(isSchemaObject);
    if (variants.length > 0) obj.items = selectBestVariant(variants);
    else delete obj.items;
  } else if (typeof obj.items === "string") {
    obj.items = schemaFromTypeHint(obj.items);
  }

  for (const [key, value] of Object.entries(obj)) {
    if (key === "properties" && isSchemaObject(value)) {
      for (const [name, propSchema] of Object.entries(value)) {
        if (!isSchemaObject(propSchema)) value[name] = schemaFromTypeHint(propSchema);
        normalizeSchemaValueShapes(value[name]);
      }
      continue;
    }
    normalizeSchemaValueShapes(value);
  }
}

// Clean JSON Schema for Antigravity API compatibility - removes unsupported keywords recursively
export function cleanJSONSchemaForAntigravity(schema) {
  if (!schema || typeof schema !== "object") return schema;

  // Mutate directly (schema is only used once per request)
  let cleaned = schema;

  // Phase 0: Expand shorthand string subschemas — must run before any pass that
  // recurses on `typeof x === "object"`, which would otherwise skip them entirely.
  expandStringSchemas(cleaned);

  // Phase 1: Convert and prepare
  convertConstToEnum(cleaned);
  convertEnumValuesToStrings(cleaned);


  // Phase 2: Flatten complex structures
  mergeAllOf(cleaned);
  convertPrefixItems(cleaned);
  flattenAnyOfOneOf(cleaned);
  flattenTypeArrays(cleaned);

  // Phase 2.1: Coerce schema shapes the Gemini Schema proto cannot express
  // (free-form property values, tuple `items`). Runs before the default-filling
  // passes below so that a dropped `items` still gets the array placeholder.
  normalizeSchemaValueShapes(cleaned);

  // Phase 2.5: Infer missing type=object when properties exist (Gemini requirement)
  ensureObjectType(cleaned);
  ensureArrayItems(cleaned);

  // Phase 3: Remove all unsupported keywords at ALL levels (including inside arrays)
  removeUnsupportedKeywords(cleaned, UNSUPPORTED_SCHEMA_CONSTRAINTS);

  // Phase 3.5: Ensure array items again after keywords removal (which may leave items as empty object)
  ensureArrayItems(cleaned);

  // Phase 4: Cleanup required fields recursively
  function cleanupRequired(obj) {
    if (!obj || typeof obj !== "object") return;

    if (obj.required && Array.isArray(obj.required) && obj.properties) {
      const validRequired = obj.required.filter(field =>
        Object.prototype.hasOwnProperty.call(obj.properties, field)
      );
      if (validRequired.length === 0) {
        delete obj.required;
      } else {
        obj.required = validRequired;
      }
    }

    // Recurse into nested objects
    forEachSubschema(obj, cleanupRequired);
  }

  cleanupRequired(cleaned);

  // Phase 5: Add placeholder for empty object schemas (Antigravity requirement)
  function addPlaceholders(obj) {
    if (!obj || typeof obj !== "object") return;

    // Empty schema {} (no type, no properties) after $ref removal — treat as object with placeholder
    if (Object.keys(obj).length === 0) {
      obj.type = "object";
      obj.properties = {
        reason: {
          type: "string",
          description: "Brief explanation of why you are calling this tool"
        }
      };
      obj.required = ["reason"];
      return;
    }

    if (obj.type === "object") {
      if (!obj.properties || typeof obj.properties !== "object" || Array.isArray(obj.properties) || Object.keys(obj.properties).length === 0) {
        obj.properties = {
          reason: {
            type: "string",
            description: "Brief explanation of why you are calling this tool"
          }
        };
        obj.required = ["reason"];
      }
    }

    // Recurse into nested objects
    forEachSubschema(obj, addPlaceholders);
  }

  addPlaceholders(cleaned);

  // Phase 5.5: Final guarantee for array schemas
  ensureArrayItems(cleaned);

  return cleaned;
}

// Gemini / Cloud Code treat a `$ref` key inside functionResponse.response as a
// pointer to functionResponse.parts and reject the request with
// "The referenced name `#/$defs/...` in function_response.response does not match
// to a display_name in the function_response.parts". Tool results that carry a
// JSON Schema / OpenAPI document (webfetch, read, MCP) hit this, so rename the key.
export const GEMINI_RESERVED_RESPONSE_KEYS = { "$ref": "_ref" };

// Recursively rename reserved keys in a tool-result payload (arrays/objects only)
export function sanitizeFunctionResponsePayload(value) {
  if (Array.isArray(value)) return value.map(sanitizeFunctionResponsePayload);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[GEMINI_RESERVED_RESPONSE_KEYS[key] ?? key] = sanitizeFunctionResponsePayload(val);
  }
  return out;
}

// Return the part with a sanitized functionResponse.response (same reference when untouched)
function sanitizeFunctionResponsePart(part) {
  const response = part?.functionResponse?.response;
  if (!response || typeof response !== "object") return part;
  return { ...part, functionResponse: { ...part.functionResponse, response: sanitizeFunctionResponsePayload(response) } };
}

// Gemini 4 rejects a merged user turn whose last part is not a functionResponse (#4802)
function moveFunctionResponsesLast(parts) {
  const responses = parts.filter(p => p.functionResponse);
  if (!responses.length) return parts;
  return [...parts.filter(p => !p.functionResponse), ...responses];
}

// Merge adjacent same-role messages, strip empty parts, ensure initial and terminal user turns
export function normalizeGeminiContents(contents, model = null) {
  const frLast = isGemini4Model(model);
  const out = [];
  for (const c of contents || []) {
    if (!c?.role || !Array.isArray(c.parts)) continue;
    const parts = c.parts.filter(p => p && Object.keys(p).length > 0).map(sanitizeFunctionResponsePart);
    if (parts.length === 0) continue;
    const last = out.at(-1);
    if (last?.role === c.role) {
      // Strict Gemini 4 parsers reject a merged user turn whose LAST part is text
      // following a functionResponse ("Requests ending with a model turn are not
      // supported" surfaces when the merged turn is malformed, issue #4802). Put
      // functionResponses first, plain text after — and when the merged turn mixes
      // both, split so the text continues in its own user turn.
      const lastHasFn = last.parts.some(p => p.functionResponse);
      const nextHasText = parts.some(p => p.text !== undefined && !p.functionResponse);
      const lastHasText = last.parts.some(p => p.text !== undefined && !p.functionResponse);
      const nextHasFn = parts.some(p => p.functionResponse);

      if (c.role === "user" && lastHasText && nextHasFn) {
        out.push({ ...c, parts: [...parts] });
      } else if (c.role === "user" && lastHasFn && nextHasText) {
        const fnParts = parts.filter(p => p.functionResponse);
        const textParts = parts.filter(p => !p.functionResponse);
        if (fnParts.length) last.parts.push(...fnParts);
        out.push({ ...c, parts: textParts.length ? textParts : [{ text: "" }] });
      } else {
        last.parts.push(...parts);
        if (frLast) last.parts = moveFunctionResponsesLast(last.parts);
      }
    } else {
      // Same rejection fires for a single incoming user turn whose parts mix
      // functionResponse with trailing text (#4802) — split it too.
      const hasFn = parts.some(p => p.functionResponse);
      const hasText = parts.some(p => p.text !== undefined && !p.functionResponse);
      if (hasFn && hasText) {
        const fnParts = parts.filter(p => p.functionResponse);
        const textParts = parts.filter(p => !p.functionResponse);
        out.push({ ...c, parts: fnParts });
        out.push({ ...c, parts: textParts.length ? textParts : [{ text: "" }] });
      } else {
        out.push({ ...c, parts: [...parts] });
      }
    }
  }

  if (out.length > 0 && out[0].role !== "user") {
    out.unshift({ role: "user", parts: [{ text: "..." }] });
  }
  if (out.length > 0 && out.at(-1).role === "model") {
    const fnCalls = (out.at(-1).parts || []).filter(p => p && p.functionCall);
    if (fnCalls.length > 0) {
      const responses = fnCalls.map(p => {
        const call = p.functionCall || {};
        const fr = {
          name: call.name || "tool",
          response: { result: "Continue." }
        };
        if (call.id) fr.id = call.id;
        return { functionResponse: fr };
      });
      out.push({ role: "user", parts: responses });
    } else {
      out.push({ role: "user", parts: [{ text: "Continue." }] });
    }
  }
  return out;
}



