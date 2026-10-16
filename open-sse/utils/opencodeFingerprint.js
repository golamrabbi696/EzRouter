/**
 * Helpers for the OpenCode free-tier client fingerprint.
 *
 * Live upstream probes (OpenCode v2, /inference/v1) show that free-tier
 * requests must declare OpenCode's own `read` and `shell` tools with their exact
 * descriptions and parameter schemas; stubbed descriptions, renamed schemas or
 * tool_choice "none" are answered with 403 FreeTierError. Caller tools are sent
 * untouched. A tool that already uses an exact fingerprint name with a
 * different definition adopts OpenCode's definition in place whenever its
 * arguments can carry them; only a genuinely different schema travels under an
 * alias, and the response side restores that caller's original name.
 */

/** Names required by the upstream free-tier gate. */
export const OPENCODE_FINGERPRINT_TOOLS = ["read", "shell"];

// Verbatim from the OpenCode v2.0.26 CLI. Upstream compares description and
// parameters, so do not reword or reformat these.
const FINGERPRINT_TOOL_DEFINITIONS = {
  read: {
    description: "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
        offset: { type: "integer", minimum: 0, description: "The line or directory entry to start reading from (1-based)" },
        limit: { type: "integer", minimum: 0, description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  shell: {
    description: "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        workdir: { type: "string", description: "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead." },
        timeout: { type: "integer", minimum: 0, description: "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default." },
        background: { type: "boolean", description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

// Request body -> names renamed for that request. transformRequest() mutates the
// same body object that chatCore passed into the executor, so a WeakMap keeps the
// mapping request-local without putting transport metadata on the wire.
const renamedToolNames = new WeakMap();

/** The fingerprint name when `name` is exactly one; "" otherwise. */
export function fingerprintToolKey(name) {
  const trimmed = String(name ?? "").trim();
  return OPENCODE_FINGERPRINT_TOOLS.includes(trimmed) ? trimmed : "";
}

/** Read a tool name from either flat ({name}) or chat ({function:{name}}) shape. */
function toolNameOf(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  if (typeof tool.name === "string" && tool.name.trim()) return tool.name.trim();
  const fn = tool.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    return fn.name.trim();
  }
  return "";
}

function chatFunctionOf(tool) {
  const fn = tool?.function;
  return fn && typeof fn === "object" && !Array.isArray(fn) ? fn : null;
}

/** True when `tool` already carries OpenCode's exact definition for `key`. */
function isFingerprintDefinition(tool, key) {
  const def = tool && (chatFunctionOf(tool) || tool);
  const want = FINGERPRINT_TOOL_DEFINITIONS[key];
  return !!def && def.description === want.description
    && JSON.stringify(def.parameters) === JSON.stringify(want.parameters);
}

function withToolName(tool, name) {
  const fn = chatFunctionOf(tool);
  return fn ? { ...tool, function: { ...fn, name } } : { ...tool, name };
}

/**
 * True when `tool` already speaks OpenCode's parameter names for `key`, so the
 * fingerprint definition can replace its own without hiding or adding an
 * argument the caller's handler expects.
 *
 * This is the common case, not an edge: OpenCode composes `shell`'s description
 * from `process.platform`, so the very same tool run on Windows reports
 * "Commands run on Windows using pwsh." while the captured definition says
 * "Commands run on Linux using bash." — a two-word difference that an exact
 * string compare rejects.
 */
function canNormalizeInPlace(tool, key) {
  const def = tool && (chatFunctionOf(tool) || tool);
  const props = def?.parameters?.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return false;

  const wanted = Object.keys(FINGERPRINT_TOOL_DEFINITIONS[key].parameters.properties || {});
  const declared = Object.keys(props);
  if (declared.some((name) => !wanted.includes(name))) return false;
  return FINGERPRINT_TOOL_DEFINITIONS[key].parameters.required.every((name) => declared.includes(name));
}

/**
 * Replace `tool`'s definition with OpenCode's while keeping its name, so the
 * wire carries a single, gate-satisfying tool instead of a caller tool plus a
 * placeholder of the same purpose.
 */
function withFingerprintDefinition(tool, key) {
  const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[key];
  const fn = chatFunctionOf(tool);
  return fn
    ? { ...tool, function: { ...fn, description, parameters } }
    : { ...tool, description, parameters };
}

/**
 * Keep caller tools on the fingerprint names whenever their arguments can carry
 * OpenCode's, and move the remaining ones off them so the exact definitions can
 * be appended without a duplicate name. Everything else, including case
 * variants such as `Read`, is preserved verbatim; upstream accepts them
 * alongside `read`.
 *
 * @param {Array} tools
 * @returns {{ tools: Array, map: Map<string,string> }} map: sent name -> original name
 */
export function concealFingerprintToolNames(tools) {
  const map = new Map();
  if (!Array.isArray(tools) || tools.length === 0) return { tools, map };

  const taken = new Set(tools.map(toolNameOf));
  const seen = new Set();
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      out.push(tool);
      continue;
    }

    const key = fingerprintToolKey(toolNameOf(tool));
    if (!key) {
      out.push(tool);
      continue;
    }

    // Duplicate declarations of one name are rejected upstream; keep the first.
    if (seen.has(key)) continue;
    seen.add(key);

    if (isFingerprintDefinition(tool, key)) {
      out.push(tool);
      continue;
    }

    // Same tool, different wording. Adopt OpenCode's definition in place: the
    // caller keeps its own name, so there is no alias to restore, no alias name
    // for the model to collide with, and no placeholder to explain away.
    if (canNormalizeInPlace(tool, key)) {
      out.push(withFingerprintDefinition(tool, key));
      continue;
    }

    let alias = `${key}_client`;
    for (let i = 2; taken.has(alias); i++) alias = `${key}_client${i}`;
    taken.add(alias);
    map.set(alias, key);
    out.push(withToolName(tool, alias));
  }
  return { tools: out, map };
}

/**
 * Append OpenCode's definition for each fingerprint tool not already declared.
 *
 * @returns {string[]} names that were appended
 */
export function appendMissingFingerprintTools(tools, flat) {
  const appended = [];
  if (!Array.isArray(tools)) return appended;
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (tools.some((tool) => fingerprintToolKey(toolNameOf(tool)) === name)) continue;
    const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[name];
    tools.push(flat
      ? { type: "function", name, description, parameters, strict: false }
      : { type: "function", function: { name, description, parameters } });
    appended.push(name);
  }
  return appended;
}

/** Invert a sent -> original rename map. */
function aliasesByOriginal(map) {
  return new Map([...map].map(([alias, original]) => [original, alias]));
}

/** Point an explicit tool_choice at the alias of a concealed caller tool. */
export function retargetToolChoice(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  const choice = body.tool_choice;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return;
  const aliases = aliasesByOriginal(map);

  if (typeof choice.name === "string") {
    const alias = aliases.get(choice.name.trim());
    if (alias) body.tool_choice = { ...choice, name: alias };
    return;
  }

  const fn = choice.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    const alias = aliases.get(fn.name.trim());
    if (alias) body.tool_choice = { ...choice, function: { ...fn, name: alias } };
  }
}

/**
 * Rename prior-turn calls to concealed caller tools as well; otherwise the model
 * reads its own earlier calls as calls to OpenCode's tool of the same name.
 */
export function aliasHistoryToolCalls(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  const aliases = aliasesByOriginal(map);

  if (Array.isArray(body.input)) {
    body.input = body.input.map((item) =>
      item?.type === "function_call" && aliases.has(item.name)
        ? { ...item, name: aliases.get(item.name) }
        : item);
  }

  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((msg) => {
      if (!Array.isArray(msg?.tool_calls)) return msg;
      return {
        ...msg,
        tool_calls: msg.tool_calls.map((call) =>
          aliases.has(call?.function?.name)
            ? { ...call, function: { ...call.function, name: aliases.get(call.function.name) } }
            : call),
      };
    });
  }
}

// Without the old "must not be used" descriptions the model does call the
// appended tools (live probe: `read` on "what files are in /etc?"), so tell it
// in the system prompt instead. Upstream does not gate on the prompt text.
// Wording matters: "not available" made the model also refuse the caller's own
// Read/Bash; "placeholders ... use the other tools" kept those working.
function noteUnavailableTools(body, flat, names) {
  const list = names.map((name) => `\`${name}\``).join(" or ");
  const note = names.length > 1
    ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
    : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
  if (flat) {
    body.instructions = typeof body.instructions === "string" && body.instructions.trim()
      ? `${body.instructions}\n\n${note}`
      : note;
    return;
  }
  // OpenAI chat shape only; Claude-shaped bodies carry `system` instead.
  if (!Array.isArray(body.messages) || body.system !== undefined) return;
  const first = body.messages[0];
  if (first?.role === "system" && typeof first.content === "string") {
    body.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...body.messages.slice(1)];
  } else {
    body.messages = [{ role: "system", content: note }, ...body.messages];
  }
}

/**
 * Canonicalise tool_calls in request messages to match upstream OpenCode's
 * quartet names and parameter schema.
 */
export function canonicalizeMessageToolCalls(messages) {
  if (!Array.isArray(messages)) return;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        const fn = call?.function;
        if (!fn || typeof fn !== "object") continue;
        const key = String(fn.name ?? "").trim().toLowerCase();
        if (["edit", "write", "read", "bash"].includes(key)) {
          fn.name = key;
          if (typeof fn.arguments === "string") {
            try {
              const args = JSON.parse(fn.arguments);
              if (args && typeof args === "object" && !Array.isArray(args)) {
                if (key === "edit") {
                  if (args.file_path !== undefined && args.filePath === undefined) {
                    args.filePath = args.file_path;
                    delete args.file_path;
                  }
                  if (args.old_string !== undefined && args.oldString === undefined) {
                    args.oldString = args.old_string;
                    delete args.old_string;
                  }
                  if (args.new_string !== undefined && args.newString === undefined) {
                    args.newString = args.new_string;
                    delete args.new_string;
                  }
                  if (args.replace_all !== undefined && args.replaceAll === undefined) {
                    args.replaceAll = args.replace_all;
                    delete args.replace_all;
                  }
                  fn.arguments = JSON.stringify(args);
                } else if (key === "write" || key === "read") {
                  if (args.file_path !== undefined && args.filePath === undefined) {
                    args.filePath = args.file_path;
                    delete args.file_path;
                  }
                  fn.arguments = JSON.stringify(args);
                }
              }
            } catch {
              // Ignore invalid JSON in arguments
            }
          }
        }
      }
    }
  }
}

/**
 * Full request-side pass: normalize caller tools that collide with a
 * fingerprint name, append OpenCode's definitions for any that are missing,
 * canonicalise history tool calls, and tell the model the appended ones are off-limits.
 *
 * @param {object} body
 * @param {boolean} flat - true for Responses tools ({name}), false for chat tools
 * @returns {Map<string,string>} map: sent name -> original name
 */
export function applyFingerprintTools(body, flat) {
  if (!body || typeof body !== "object") return new Map();

  const { tools, map } = concealFingerprintToolNames(body.tools);
  body.tools = Array.isArray(tools) ? tools : [];
  const appended = appendMissingFingerprintTools(body.tools, flat);
  retargetToolChoice(body, map);
  aliasHistoryToolCalls(body, map);
  canonicalizeMessageToolCalls(body.messages);
  if (appended.length) noteUnavailableTools(body, flat, appended);

  // Responses keeps its explicit auto default. Never default to "none": upstream
  // answers tool_choice "none" with 403 FreeTierError.
  if (!body.tool_choice && flat) body.tool_choice = "auto";

  recordRenamedToolNames(body, map);
  return map;
}

/** Store the rename map for `body`. */
export function recordRenamedToolNames(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  renamedToolNames.set(body, map);
}

/** Retrieve the rename map for `body`. */
export function takeRenamedToolNames(body) {
  if (!body || typeof body !== "object") return null;
  return renamedToolNames.get(body) || null;
}

// Response side -------------------------------------------------------------

/** Normalize quartet tool arguments from OpenCode camelCase to snake_case */
export function normalizeQuartetToolArgs(name, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const lower = String(name || "").toLowerCase();
  const out = { ...input };
  if (lower === "edit") {
    const path = out.file_path ?? out.filePath ?? out.path ?? out.file;
    if (path !== undefined) {
      out.file_path = path;
      delete out.filePath;
      delete out.path;
      delete out.file;
    }
    const oldStr = out.old_string ?? out.oldString ?? out.old_str ?? out.oldText ?? out.old_text;
    if (oldStr !== undefined) {
      out.old_string = oldStr;
      delete out.oldString;
      delete out.old_str;
      delete out.oldText;
      delete out.old_text;
    }
    const newStr = out.new_string ?? out.newString ?? out.new_str ?? out.newText ?? out.new_text;
    if (newStr !== undefined) {
      out.new_string = newStr;
      delete out.newString;
      delete out.new_str;
      delete out.newText;
      delete out.new_text;
    }
    const replaceAll = out.replace_all ?? out.replaceAll;
    if (replaceAll !== undefined) {
      out.replace_all = Boolean(replaceAll);
      delete out.replaceAll;
    }
  } else if (lower === "write" || lower === "read") {
    const path = out.file_path ?? out.filePath ?? out.path ?? out.file;
    if (path !== undefined) {
      out.file_path = path;
      delete out.filePath;
      delete out.path;
      delete out.file;
    }
  } else if (lower === "bash") {
    const cmd = out.command ?? out.cmd;
    if (cmd !== undefined) {
      out.command = cmd;
      delete out.cmd;
    }
  }
  return out;
}

/** Normalize quartet tool arguments JSON string */
export function normalizeQuartetToolArgsJson(name, argsJson) {
  if (typeof argsJson !== "string") return argsJson;
  try {
    const parsed = JSON.parse(argsJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return argsJson;
    return JSON.stringify(normalizeQuartetToolArgs(name, parsed));
  } catch {
    return argsJson;
  }
}

/** Restore caller tool spellings in supported response/event shapes. */
export function restoreToolNames(payload, map) {
  if (!map?.size || !payload) return payload;
  if (Array.isArray(payload)) return payload.map((item) => restoreToolNames(item, map));
  if (typeof payload !== "object") return payload;

  let out = payload;
  const put = (key, value) => {
    if (out === payload) out = { ...payload };
    out[key] = value;
  };

  // Claude streaming content_block_start event.
  if (payload.type === "content_block_start") {
    const block = payload.content_block;
    if (block?.type === "tool_use" && typeof block.name === "string" && map.has(block.name)) {
      put("content_block", { ...block, name: map.get(block.name) });
    }
  }

  // Claude non-streaming message body.
  if (Array.isArray(payload.content)) {
    put("content", payload.content.map((block) => {
      if (block?.type === "tool_use" && typeof block.name === "string") {
        const restoredName = map.has(block.name) ? map.get(block.name) : block.name;
        let input = block.input;
        if (input && typeof input === "object") {
          input = normalizeQuartetToolArgs(restoredName, input);
        }
        return { ...block, name: restoredName, input };
      }
      return block;
    }));
  }

  // OpenAI Chat Completions, both streaming delta and JSON message shapes.
  if (Array.isArray(payload.choices)) {
    put("choices", payload.choices.map((choice) => {
      let changed = false;
      const next = { ...choice };
      for (const holder of ["delta", "message"]) {
        const value = choice?.[holder];
        if (!value || !Array.isArray(value.tool_calls) || value.tool_calls.length === 0) continue;
        const calls = value.tool_calls.map((call) => {
          const name = call?.function?.name;
          const restoredName = typeof name === "string" && map.has(name) ? map.get(name) : name;
          let changedCall = false;
          let fn = call.function;
          if (restoredName !== name) {
            changed = true;
            changedCall = true;
            fn = { ...fn, name: restoredName };
          }
          if (holder === "message" && typeof fn?.arguments === "string") {
            const mappedArgs = normalizeQuartetToolArgsJson(restoredName || name, fn.arguments);
            if (mappedArgs !== fn.arguments) {
              changed = true;
              changedCall = true;
              fn = { ...fn, arguments: mappedArgs };
            }
          }
          return changedCall ? { ...call, function: fn } : call;
        });
        next[holder] = { ...value, tool_calls: calls };
      }
      return changed ? next : choice;
    }));
  }

  // OpenAI Responses final JSON body.
  if (Array.isArray(payload.output)) {
    put("output", payload.output.map((item) =>
      item?.type === "function_call" && typeof item.name === "string" && map.has(item.name)
        ? { ...item, name: map.get(item.name) }
        : item));
  }

  // OpenAI Responses SSE events such as response.output_item.added/done.
  const item = payload.item;
  if (item?.type === "function_call" && typeof item.name === "string" && map.has(item.name)) {
    put("item", { ...item, name: map.get(item.name) });
  }

  return out;
}
