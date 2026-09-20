// Gemini helper functions for translator

import { safeParseJSON } from "../concerns/json.js";
import { OPENAI_BLOCK } from "../schema/index.js";

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
  "gap", "padding", "strokeColor", "strokeThickness", "textColor"
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

// Helper: Remove unsupported keywords recursively from object/array
// Also strips all vendor extension fields (x- prefixed) not supported by Gemini.
// Walks only schema nodes: a JSON Schema alternates schema-node → "properties"
// name-map → schema-node, and the name-map keys are user parameter names, not
// schema keywords (a param literally named "title"/"format"/"properties" must
// survive — issue #2884).
function removeUnsupportedKeywords(obj, keywords) {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      removeUnsupportedKeywords(item, keywords);
    }
    return;
  }

  // Property name-map: keys are user-defined parameter names. Descend into
  // each value (which is a schema node) but never delete the key itself.
  if (obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties)) {
    for (const propValue of Object.values(obj.properties)) {
      removeUnsupportedKeywords(propValue, keywords);
    }
  }

  for (const key of Object.keys(obj)) {
    if (key === "properties") continue; // handled above
    // Strip stray non-schema keys (e.g. `value`) only at real schema nodes —
    // a node is a schema when it has type/properties/items; inside a property
    // name-map `value` is a legitimate user parameter name (issue #2902/#2884).
    const isSchemaNode = obj.type !== undefined || obj.properties !== undefined || obj.items !== undefined;
    if (isSchemaNode && STRAY_SCHEMA_KEYS.has(key)) {
      delete obj[key];
      continue;
    }
    if (keywords.includes(key) || key.startsWith("x-")) {
      delete obj[key];
      continue;
    }

    const value = obj[key];
    if (value && typeof value === "object") {
      removeUnsupportedKeywords(value, keywords);
    }
  }
}

// Convert const to enum
function convertConstToEnum(obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.const !== undefined && !obj.enum) {
    obj.enum = [obj.const];
    delete obj.const;
  }

  forEachChildSchema(obj, convertConstToEnum);
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

  forEachChildSchema(obj, convertEnumValuesToStrings);
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

  forEachChildSchema(obj, mergeAllOf);
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

  forEachChildSchema(obj, flattenAnyOfOneOf);
}

// Flatten type arrays
function flattenTypeArrays(obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.type && Array.isArray(obj.type)) {
    const nonNullTypes = obj.type.filter(t => t !== "null");
    obj.type = nonNullTypes.length > 0 ? nonNullTypes[0] : "string";
  }

  forEachChildSchema(obj, flattenTypeArrays);
}

// Keys whose value is a MAP of schemas (name -> schema), not a schema itself.
// A tool may legitimately declare a property named "properties" or "items", so a
// blind `Object.values()` walk would treat the map as a schema node and mutate it.
const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];

// Visit child schemas without ever mistaking a schema map for a schema.
function forEachChildSchema(obj, fn) {
  for (const [key, value] of Object.entries(obj)) {
    if (!value || typeof value !== "object") continue;
    if (SCHEMA_MAPS.includes(key)) {
      for (const sub of Object.values(value)) if (sub && typeof sub === "object") fn(sub);
    } else if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item === "object") fn(item);
    } else {
      fn(value);
    }
  }
}

// Infer missing type=object when properties exist (Gemini requires explicit type).
// Descends only into schema nodes — the property name-map is NOT a schema node,
// so a parameter literally named "properties" must not get a bogus type injected
// (issue #2884).
function ensureObjectType(obj) {
  if (!obj || typeof obj !== "object") return;
  if (obj.properties && !obj.type) obj.type = "object";
  forEachChildSchema(obj, ensureObjectType);
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

  forEachChildSchema(obj, convertPrefixItems);
}

// Gemini requires items on every type:"array" schema — fill a permissive placeholder
function ensureArrayItems(obj) {
  if (!obj || typeof obj !== "object") return;
  if (obj.type === "array" && !obj.items) {
    obj.items = { type: "string" };
  }
  forEachChildSchema(obj, ensureArrayItems);
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

function expandStringSchemas(obj) {
  if (!obj || typeof obj !== "object") return;

  const expand = (value) => (typeof value === "string" ? { type: value } : value);

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

  forEachChildSchema(obj, expandStringSchemas);
}

// Normalize shorthand string property definitions (e.g. { properties: { foo: "object" } })
function normalizePropertyDefinitions(obj) {
  if (!obj || typeof obj !== "object") return;

  if (obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties)) {
    for (const [key, prop] of Object.entries(obj.properties)) {
      if (typeof prop === "string") {
        obj.properties[key] = {
          type: prop === "object" ? "object" : prop,
        };
      }
    }
  }

  forEachChildSchema(obj, normalizePropertyDefinitions);
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

  // Phase 1.5: Normalize property definitions before structural transforms
  normalizePropertyDefinitions(cleaned);

  // Phase 2: Flatten complex structures
  mergeAllOf(cleaned);
  convertPrefixItems(cleaned);
  flattenAnyOfOneOf(cleaned);
  flattenTypeArrays(cleaned);

  // Phase 2.5: Infer missing type=object when properties exist (Gemini requirement)
  ensureObjectType(cleaned);
  ensureArrayItems(cleaned);

  // Phase 3: Remove all unsupported keywords at ALL levels (including inside arrays)
  removeUnsupportedKeywords(cleaned, UNSUPPORTED_SCHEMA_CONSTRAINTS);

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
    forEachChildSchema(obj, cleanupRequired);
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
    forEachChildSchema(obj, addPlaceholders);
  }

  addPlaceholders(cleaned);

  return cleaned;
}

// Merge adjacent same-role messages, strip empty parts, ensure initial and final user turns
export function normalizeGeminiContents(contents) {
  const out = [];
  for (const c of contents || []) {
    if (!c?.role || !Array.isArray(c.parts)) continue;
    const parts = c.parts.filter(p => p && Object.keys(p).length > 0);
    if (parts.length === 0) continue;
    const last = out.at(-1);
    if (last?.role === c.role) {
      const lastHasFnResp = last.parts.some(p => p?.functionResponse);
      const currHasFnResp = parts.some(p => p?.functionResponse);
      const lastHasText = last.parts.some(p => p?.text);
      const currHasText = parts.some(p => p?.text);

      // Vertex AI / Gemini requires functionResponse parts to be in their own user turn.
      if (c.role === "user" && ((lastHasFnResp && currHasText) || (lastHasText && currHasFnResp))) {
        out.push({ ...c, parts: [...parts] });
      } else {
        last.parts.push(...parts);
      }
    } else {
      out.push({ ...c, parts: [...parts] });
    }
  }

  if (out.length > 0 && out[0].role !== "user") {
    out.unshift({ role: "user", parts: [{ text: "..." }] });
  }

  // Gemini / Vertex strictly require that the last turn in contents is a "user" turn.
  if (out.length > 0 && out.at(-1).role === "model") {
    const lastTurn = out.at(-1);
    const functionCalls = lastTurn.parts.filter(p => p?.functionCall);

    if (functionCalls.length > 0) {
      const functionResponses = functionCalls.map(p => ({
        functionResponse: {
          ...(p.functionCall.id ? { id: p.functionCall.id } : {}),
          name: p.functionCall.name,
          response: { result: "No response provided" }
        }
      }));
      out.push({
        role: "user",
        parts: functionResponses
      });
    } else {
      out.push({
        role: "user",
        parts: [{ text: "Continue" }]
      });
    }
  }

  return out;
}



