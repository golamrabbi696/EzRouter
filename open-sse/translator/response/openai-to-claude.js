import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { ROLE, CLAUDE_BLOCK, MODEL_FALLBACK, OPENAI_FINISH } from "../schema/index.js";
import { fromOpenAIFinish } from "../concerns/finishReason.js";
import { extractReasoningText } from "../concerns/reasoning.js";
import { repairDuplicatedJsonArguments, appendToolArgs } from "../concerns/toolArgs.js";
import { ERROR_TYPES, DEFAULT_ERROR_MESSAGES } from "../../config/errorConfig.js";

// Legacy "proxy_" prefix used by older request translators. Response strips it
// defensively so tool names from such turns resolve back (e.g. proxy_Read → Read
// for arg sanitization). Current request translator emits no prefix ("") — strip
// is then a no-op. Kept intentionally; do NOT couple to request's empty prefix.
const CLAUDE_OAUTH_TOOL_PREFIX = "proxy_";

// Normalize common parameter alias hallucinations from non-Anthropic models
// when calling Claude Code / Claude Desktop built-in tools (Bash, Read, Edit, Write, Glob, Grep).
export function normalizeClaudeToolInput(toolName, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const rawName = String(toolName || "");
  const name = rawName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)
    ? rawName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length)
    : rawName;
  const lower = name.toLowerCase();

  if (lower === "bash" || lower === "execute_command") {
    if (args.command === undefined) {
      const alt = args.cmd ?? args.script ?? args.command_line ?? args.commandLine ?? args.input ?? args.code;
      if (typeof alt === "string") args.command = alt;
    }
    for (const k of ["cmd", "script", "command_line", "commandLine"]) {
      if (args.command !== undefined && k in args) delete args[k];
    }
  } else if (lower === "read" || lower === "edit" || lower === "write" || lower === "multiedit") {
    if (args.file_path === undefined) {
      const alt = args.path ?? args.file ?? args.filepath ?? args.filePath ?? args.filename;
      if (typeof alt === "string") args.file_path = alt;
    }
    delete args.filePath;
    if (lower === "edit" || lower === "multiedit") {
      if (args.old_string === undefined && (args.old_str ?? args.old_text ?? args.search ?? args.oldString ?? args.oldText) !== undefined) {
        args.old_string = args.old_str ?? args.old_text ?? args.search ?? args.oldString ?? args.oldText;
      }
      if (args.new_string === undefined && (args.new_str ?? args.new_text ?? args.replace ?? args.newString ?? args.newText) !== undefined) {
        args.new_string = args.new_str ?? args.new_text ?? args.replace ?? args.newString ?? args.newText;
      }
      const replaceAll = args.replace_all ?? args.replaceAll;
      if (replaceAll !== undefined) {
        args.replace_all = Boolean(replaceAll);
        delete args.replaceAll;
      }
      delete args.oldString;
      delete args.newString;
    }
    if (lower === "write" && args.content === undefined && typeof (args.text ?? args.data ?? args.body) === "string") {
      args.content = args.text ?? args.data ?? args.body;
    }
    if (name === "Read" || lower === "read") sanitizeReadArgs(args);
  } else if (lower === "glob" || lower === "grep") {
    if (args.pattern === undefined) {
      const alt = args.query ?? args.search ?? args.regex ?? args.glob;
      if (typeof alt === "string") args.pattern = alt;
    }
    if (args.path === undefined && typeof (args.dir ?? args.directory ?? args.folder ?? args.file_path) === "string") {
      args.path = args.dir ?? args.directory ?? args.folder ?? args.file_path;
    }
  }
  return args;
}

// Sanitize tool call arguments to fix bad params from non-Anthropic models.
// Fast path: single parse for the common valid case; repair only on failure.
export function sanitizeToolArgs(toolName, argsJson) {
  let args;
  try {
    args = JSON.parse(argsJson);
  } catch {
    const repairedJson = repairDuplicatedJsonArguments(argsJson);
    try {
      args = JSON.parse(repairedJson);
    } catch {
      return repairedJson;
    }
  }
  normalizeClaudeToolInput(toolName, args);
  return JSON.stringify(args);
}

export function sanitizeEditArgs(args) {
  if (!args || typeof args !== "object") return;
  const path = args.file_path ?? args.filePath ?? args.path ?? args.file;
  if (path !== undefined) {
    args.file_path = path;
    delete args.filePath;
    delete args.path;
    delete args.file;
  }
  const oldStr = args.old_string ?? args.oldString ?? args.old_str ?? args.oldText ?? args.old_text;
  if (oldStr !== undefined) {
    args.old_string = oldStr;
    delete args.oldString;
    delete args.old_str;
    delete args.oldText;
    delete args.old_text;
  }
  const newStr = args.new_string ?? args.newString ?? args.new_str ?? args.newText ?? args.new_text;
  if (newStr !== undefined) {
    args.new_string = newStr;
    delete args.newString;
    delete args.new_str;
    delete args.newText;
    delete args.new_text;
  }
  const replaceAll = args.replace_all ?? args.replaceAll;
  if (replaceAll !== undefined) {
    args.replace_all = Boolean(replaceAll);
    delete args.replaceAll;
  }
}

export function sanitizeWriteArgs(args) {
  if (!args || typeof args !== "object") return;
  const path = args.file_path ?? args.filePath ?? args.path ?? args.file;
  if (path !== undefined) {
    args.file_path = path;
    delete args.filePath;
    delete args.path;
    delete args.file;
  }
}

export function sanitizeBashArgs(args) {
  if (!args || typeof args !== "object") return;
  const cmd = args.command ?? args.cmd;
  if (cmd !== undefined) {
    args.command = cmd;
    delete args.cmd;
  }
}

export function sanitizeReadArgs(args) {
  if (!args || typeof args !== "object") return;
  const path = args.file_path ?? args.filePath ?? args.path ?? args.file;
  if (path !== undefined) {
    args.file_path = path;
    delete args.filePath;
    delete args.path;
    delete args.file;
  }
  if (typeof args.limit === "string" && /^\d+$/.test(args.limit)) args.limit = Number(args.limit);
  if (typeof args.offset === "string" && /^-?\d+$/.test(args.offset)) args.offset = Number(args.offset);

  if (typeof args.limit === "number") {
    if (args.limit > 2000) args.limit = 2000;
    if (args.limit < 1) delete args.limit;
  }
  if (typeof args.offset === "number" && args.offset < 0) args.offset = 0;

  if ("pages" in args && !isValidPdfPagesArg(args.file_path, args.pages)) {
    delete args.pages;
  }
}

function isValidPdfPagesArg(filePath, pages) {
  return typeof filePath === "string" &&
    filePath.toLowerCase().endsWith(".pdf") &&
    typeof pages === "string" &&
    /^\d+(?:-\d+)?$/.test(pages);
}

// Helper: stop thinking block if started
function stopThinkingBlock(state, results) {
  if (!state.thinkingBlockStarted) return;
  results.push({
    type: "content_block_stop",
    index: state.thinkingBlockIndex
  });
  state.thinkingBlockStarted = false;
}

// Helper: stop text block if started
function stopTextBlock(state, results) {
  if (!state.textBlockStarted || state.textBlockClosed) return;
  state.textBlockClosed = true;
  results.push({
    type: "content_block_stop",
    index: state.textBlockIndex
  });
  state.textBlockStarted = false;
}

// Helper: flush buffered tool args + close every open tool_use block
function flushToolBlocks(state, results) {
  if (!state.toolCalls) return;
  for (const [idx, toolInfo] of state.toolCalls) {
    if (toolInfo.closed) continue;
    toolInfo.closed = true;
    // Emit buffered + sanitized args as single delta before stop
    const buffered = state.toolArgBuffers?.get(idx);
    if (buffered) {
      const sanitized = sanitizeToolArgs(toolInfo.name, buffered);
      results.push({
        type: "content_block_delta",
        index: toolInfo.blockIndex,
        delta: { type: "input_json_delta", partial_json: sanitized }
      });
    }
    results.push({
      type: "content_block_stop",
      index: toolInfo.blockIndex
    });
  }
}

// Convert OpenAI-shaped usage ({prompt_tokens, completion_tokens, ...}) to the
// Claude shape ({input_tokens, output_tokens, cache_*}).
function toClaudeUsage(usage) {
  const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const outputTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;

  // Extract cache tokens from prompt_tokens_details
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
  const cacheCreationTokens = usage.prompt_tokens_details?.cache_creation_tokens;
  const cacheReadTokens = typeof cachedTokens === "number" ? cachedTokens : 0;
  const cacheCreateTokens = typeof cacheCreationTokens === "number" ? cacheCreationTokens : 0;

  // input_tokens = prompt_tokens - cached_tokens - cache_creation_tokens
  // Because OpenAI's prompt_tokens includes all prompt-side tokens
  const claudeUsage = {
    input_tokens: promptTokens - cacheReadTokens - cacheCreateTokens,
    output_tokens: outputTokens
  };
  if (cacheReadTokens > 0) claudeUsage.cache_read_input_tokens = cacheReadTokens;
  if (cacheCreateTokens > 0) claudeUsage.cache_creation_input_tokens = cacheCreateTokens;

  // Preserve reasoning tokens for usage tracking: Claude clients ignore the
  // extra field, but saveUsageStats/canonicalizeUsage need it populated or
  // the pivot drops every reasoning count for translated streams.
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
  if (typeof reasoningTokens === "number" && reasoningTokens > 0) {
    claudeUsage.reasoning_tokens = reasoningTokens;
  }

  return claudeUsage;
}

// Flush-time finalization: the upstream stream ended without a finish_reason
// (truncated connection, or a gemini-family stream that closed after content).
// Close open blocks and emit message_delta + message_stop so the Claude client
// never hangs on a dangling message.
function finalizeOnFlush(state) {
  if (!state.messageStartSent || state.claudeFinishHandled) return null;
  state.claudeFinishHandled = true;

  const results = [];
  stopThinkingBlock(state, results);
  stopTextBlock(state, results);
  flushToolBlocks(state, results);

  // state.usage may still be OpenAI-shaped here: the gemini stage writes
  // prompt/completion counts into the shared pivot state, and only a real
  // finish chunk converts them — which a truncated stream never delivers.
  const usage = state.usage?.input_tokens != null
    ? state.usage
    : state.usage?.prompt_tokens != null
      ? toClaudeUsage(state.usage)
      : { input_tokens: 0, output_tokens: 0 };

  const stopReason = state.toolCalls.size > 0 ? "tool_use" : "end_turn";
  results.push({
    type: "message_delta",
    delta: { stop_reason: stopReason },
    usage
  });
  results.push({ type: "message_stop" });
  return results;
}

// Convert OpenAI stream chunk to Claude format
export function openaiToClaudeResponse(chunk, state) {
  // An in-band upstream failure has no choices, so the guard below would drop it and the Claude
  // client would see a truncated answer end cleanly. Claude streams report it as an error event.
  if (chunk?.error) {
    state.claudeFinishHandled = true;
    return [{
      type: "error",
      error: {
        type: chunk.error.type || chunk.error.code || ERROR_TYPES[500].type,
        message: chunk.error.message || DEFAULT_ERROR_MESSAGES[500],
      },
    }];
  }
  if (!chunk) return finalizeOnFlush(state);
  if (!chunk.choices?.[0]) return null;

  const results = [];
  const choice = chunk.choices[0];
  const delta = choice.delta;

  // Track usage from OpenAI chunk if available
  if (chunk.usage && typeof chunk.usage === "object") {
    state.usage = toClaudeUsage(chunk.usage);
  }

  // First chunk - ALWAYS send message_start first
  if (!state.messageStartSent) {
    state.messageStartSent = true;
    state.messageId = chunk.id?.replace("chatcmpl-", "") || `msg_${Date.now()}`;
    if (!state.messageId || state.messageId === "chat" || state.messageId.length < 8) {
      state.messageId = chunk.extend_fields?.requestId ||
        chunk.extend_fields?.traceId ||
        `msg_${Date.now()}`;
    }
    // The state was seeded with the model the CLIENT asked for (see
    // createSSEStream). Echoing the upstream provider's chunk.model (e.g.
    // "glm-5.3" behind a claude-* combo) makes Anthropic-format clients save
    // that name as the session model and fail to restore it on resume.
    state.model = state.responseModel || state.model || chunk.model || MODEL_FALLBACK;
    state.nextBlockIndex = 0;
    results.push({
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: ROLE.ASSISTANT,
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  }

  // Handle reasoning (thinking) across vendor shapes - GLM/DeepSeek/Qwen/MiniMax/etc.
  const reasoningContent = extractReasoningText(delta);
  if (reasoningContent) {
    stopTextBlock(state, results);

    if (!state.thinkingBlockStarted) {
      state.thinkingBlockIndex = state.nextBlockIndex++;
      state.thinkingBlockStarted = true;
      results.push({
        type: "content_block_start",
        index: state.thinkingBlockIndex,
        content_block: { type: CLAUDE_BLOCK.THINKING, thinking: "" }
      });
    }

    results.push({
      type: "content_block_delta",
      index: state.thinkingBlockIndex,
      delta: { type: "thinking_delta", thinking: reasoningContent }
    });
  }

  // Handle regular content
  if (delta?.content) {
    stopThinkingBlock(state, results);

    if (!state.textBlockStarted) {
      state.textBlockIndex = state.nextBlockIndex++;
      state.textBlockStarted = true;
      state.textBlockClosed = false;
      results.push({
        type: "content_block_start",
        index: state.textBlockIndex,
        content_block: { type: CLAUDE_BLOCK.TEXT, text: "" }
      });
    }

    results.push({
      type: "content_block_delta",
      index: state.textBlockIndex,
      delta: { type: "text_delta", text: delta.content }
    });
  }

  // Tool calls
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;

      // GLM/fireworks repeats id+null-name on every arg chunk; open block once per idx
      if (tc.id && !state.toolCalls.has(idx)) {
        stopThinkingBlock(state, results);
        stopTextBlock(state, results);

        const toolBlockIndex = state.nextBlockIndex++;
        state.toolCalls.set(idx, { id: tc.id, name: tc.function?.name || "", blockIndex: toolBlockIndex });

        // Strip prefix from tool name for response
        let toolName = tc.function?.name || "";
        if (toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)) {
          toolName = toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length);
        }
        if (state.toolNameMap?.has(toolName)) {
          toolName = state.toolNameMap.get(toolName);
        } else {
          const lower = toolName.toLowerCase();
          if (lower === "edit") toolName = "Edit";
          else if (lower === "read") toolName = "Read";
          else if (lower === "write") toolName = "Write";
          else if (lower === "bash") toolName = "Bash";
        }

        results.push({
          type: "content_block_start",
          index: toolBlockIndex,
          content_block: {
            type: CLAUDE_BLOCK.TOOL_USE,
            id: tc.id,
            name: toolName,
            input: {}
          }
        });
      }

      if (tc.function?.arguments) {
        const toolInfo = state.toolCalls.get(idx);
        if (toolInfo) {
          // Buffer args instead of streaming — sanitize at finish to fix bad params
          if (!state.toolArgBuffers) state.toolArgBuffers = new Map();
          const current = state.toolArgBuffers.get(idx) || "";
          state.toolArgBuffers.set(idx, appendToolArgs(current, tc.function.arguments));
        }
      }
    }
  }

  // Finish — guard with a Claude-specific flag, NOT the shared state.finishReason:
  // in a pivot like Antigravity/Gemini → OpenAI → Claude the upstream stage already
  // sets state.finishReason (for stream.js usage injection); keying on it would
  // suppress this flush and drop the buffered tool-call input_json_delta. The flag
  // also dedupes repeated finish_reason chunks from OpenAI-compatible models.
  if (choice.finish_reason) {
    if (!state.claudeFinishHandled) {
      state.claudeFinishHandled = true;
      if (state.claudeTerminalEmitted) return results.length > 0 ? results : null;
      state.claudeTerminalEmitted = true;

      stopThinkingBlock(state, results);
      stopTextBlock(state, results);
      flushToolBlocks(state, results);

      // Mark finish for later usage injection in stream.js
      state.finishReason = choice.finish_reason;

      if (choice.finish_reason === OPENAI_FINISH.ERROR) {
        // Upstream aborted the turn (e.g. Gemini MALFORMED_FUNCTION_CALL or an error
        // object embedded in a 200 stream). A clean end_turn here makes the client
        // treat a broken turn as a finished answer; a mid-stream error event is
        // retryable by Anthropic clients.
        const message = state.upstreamError?.message ||
          "Upstream aborted the response (malformed function call or empty candidate)";
        results.push({
          type: "error",
          error: { type: "api_error", message }
        });
      } else {
        // Use tracked usage (will be estimated in stream.js if not valid)
        const finalUsage = state.usage || { input_tokens: 0, output_tokens: 0 };
        results.push({
          type: "message_delta",
          delta: { stop_reason: convertFinishReason(choice.finish_reason) },
          usage: finalUsage
        });
        results.push({ type: "message_stop" });
      }
    } else if (state.usage && !state.messageStopSent) {
      // Later finish chunk (commonly finish_reason:"stop" carrying usage).
      // Tool blocks are already closed; emit a usage-only message_delta so the
      // client still receives final usage without re-opening/duplicating blocks.
      state.messageStopSent = true;
      results.push({
        type: "message_delta",
        delta: { stop_reason: convertFinishReason(choice.finish_reason) },
        usage: state.usage
      });
    }
  }

  return results.length > 0 ? results : null;
}

const convertFinishReason = (reason) => fromOpenAIFinish(reason, "claude");

// Register
register(FORMATS.OPENAI, FORMATS.CLAUDE, null, openaiToClaudeResponse);
