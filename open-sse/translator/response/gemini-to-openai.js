import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { ROLE, OPENAI_BLOCK, OPENAI_FINISH, DEFAULT_IMAGE_MIME } from "../schema/index.js";
import { buildChunk } from "../concerns/chunk.js";
import { toOpenAIUsage } from "../concerns/usage.js";
import { reasoningDelta } from "../concerns/reasoning.js";
import { encodeDataUri } from "../concerns/image.js";
import { toOpenAIFinish } from "../concerns/finishReason.js";
import { readGeminiFunctionCallSignature, attachOpenAIToolCallSignature } from "../concerns/thoughtSignature.js";

// Build chunk meta for current gemini state
function chunkMeta(state) {
  return { id: `chatcmpl-${state.messageId}`, created: Math.floor(Date.now() / 1000), model: state.model };
}

// Build a tool_call chunk from a gemini functionCall part (shared by sig/non-sig branches).
// `signature` is the real thoughtSignature Google returned for this functionCall
// part (null when the part has none — Gemini 3 attaches a signature to the
// FIRST parallel functionCall only; subsequent parallel calls carry none).
function emitFunctionCall(functionCall, signature, state) {
  const rawName = functionCall.name;
  // Restore original tool name from mapping (AG cloaking)
  const fcName = state.toolNameMap?.get(rawName) || rawName;
  const fcArgs = functionCall.args || {};
  const toolCallIndex = state.functionIndex++;
  // Prefer the upstream-provided call id (Gemini 3 sends one) — it round-trips to
  // functionResponse without name reconstruction. Fall back to a generated id.
  // Anthropic tool_use ids must match [a-zA-Z0-9_-], so sanitize either way.
  if (!state.seenToolCallIds) state.seenToolCallIds = new Set();
  const upstreamId = functionCall.id;
  const rawId = upstreamId && !state.seenToolCallIds.has(upstreamId)
    ? upstreamId
    : `${fcName}_${Date.now()}_${toolCallIndex}`;
  const id = rawId.replace(/[^a-zA-Z0-9_-]/g, "_");
  state.seenToolCallIds.add(id);
  if (upstreamId) state.seenToolCallIds.add(upstreamId);
  const toolCall = {
    id,
    index: toolCallIndex,
    type: OPENAI_BLOCK.FUNCTION,
    function: { name: fcName, arguments: JSON.stringify(fcArgs) },
  };
  // Preserve Gemini's thoughtSignature on the tool_call so the client replays
  // it back in the next turn (Gemini 3 rejects tool_calls without it on the
  // first functionCall per turn). See concerns/thoughtSignature.js.
  if (signature) attachOpenAIToolCallSignature(toolCall, signature);
  // Keep Gemini bookkeeping separate from the shared translator state.toolCalls map.
  // The downstream OpenAI→Claude translator uses state.toolCalls for Claude block
  // metadata; pre-populating it here makes Anthropic tool deltas lose index.
  state.geminiToolCallCount = (state.geminiToolCallCount || 0) + 1;
  return buildChunk(chunkMeta(state), { tool_calls: [toolCall] }, null);
}

// Convert Gemini response chunk to OpenAI format
export function geminiToOpenAIResponse(chunk, state) {
  if (!chunk) return null;

  // Handle Antigravity wrapper
  const response = chunk.response || chunk;
  if (!response) return null;

  const results = [];
  const candidate = response.candidates?.[0];
  const upstreamError = response.error || chunk.error;
  const blockReason = response.promptFeedback?.blockReason;

  // Candidate-less chunk with nothing to surface: harvest usage from keep-alive
  // chunks (usageMetadata-only) and skip. Dropping error/blockReason chunks here
  // used to leave the client with an empty 200 stream that never closes.
  if (!candidate && !upstreamError && !blockReason) {
    const keepAliveUsage = toOpenAIUsage(response.usageMetadata || chunk.usageMetadata, "gemini");
    if (keepAliveUsage) state.usage = keepAliveUsage;
    return null;
  }

  // Initialize state
  if (!state.messageId) {
    state.messageId = response.responseId || `msg_${Date.now()}`;
    state.model = response.modelVersion || "gemini";
    state.functionIndex = 0;
    state.geminiToolCallCount = 0;
    results.push(buildChunk(chunkMeta(state), { role: ROLE.ASSISTANT }, null));
  }

  // Error object embedded mid-stream in a 200 response (e.g. RESOURCE_EXHAUSTED):
  // close the message with an error finish so downstream surfaces it instead of hanging.
  if (!candidate && upstreamError) {
    state.upstreamError = upstreamError;
    const errorChunk = buildChunk(chunkMeta(state), {}, OPENAI_FINISH.ERROR);
    if (state.usage) errorChunk.usage = state.usage;
    results.push(errorChunk);
    state.finishReason = OPENAI_FINISH.ERROR;
    return results;
  }

  // Prompt blocked before any candidate was produced: close as content_filter.
  if (!candidate && blockReason) {
    const blockedChunk = buildChunk(chunkMeta(state), {}, OPENAI_FINISH.CONTENT_FILTER);
    if (state.usage) blockedChunk.usage = state.usage;
    results.push(blockedChunk);
    state.finishReason = OPENAI_FINISH.CONTENT_FILTER;
    return results;
  }

  const content = candidate.content;

  // Process parts
  if (content?.parts) {
    for (const part of content.parts) {
      const partSignature = readGeminiFunctionCallSignature(part);
      const isThought = part.thought === true;

      // Handle thought signature (thinking mode)
      if (partSignature) {
        const hasTextContent = part.text !== undefined && part.text !== "";
        const hasFunctionCall = !!part.functionCall;

        if (hasTextContent) {
          results.push(buildChunk(
            chunkMeta(state),
            isThought ? reasoningDelta(part.text) : { content: part.text },
            null
          ));
        }

        if (hasFunctionCall) {
          results.push(emitFunctionCall(part.functionCall, partSignature, state));
        }
        continue;
      }

      // Text content. Gemini marks model-internal thinking with `thought: true`.
      // Some responses include a thoughtSignature, but Google AI Studio/Gemini API
      // can also stream thought parts without a signature; those must not be
      // surfaced as normal assistant content in OpenAI-compatible clients.
      if (part.text !== undefined && part.text !== "") {
        results.push(buildChunk(
          chunkMeta(state),
          isThought ? reasoningDelta(part.text) : { content: part.text },
          null
        ));
      }

      // Function call. Google only attaches a thoughtSignature to the FIRST
      // parallel functionCall part; sibling parallel parts arrive here with
      // no signature and are emitted verbatim — the upstream payload shape
      // must not be altered (per Gemini tool-state rules).
      if (part.functionCall) {
        results.push(emitFunctionCall(part.functionCall, partSignature, state));
      }

      // Inline data (images)
      const inlineData = part.inlineData || part.inline_data;
      if (inlineData?.data) {
        const mimeType = inlineData.mimeType || inlineData.mime_type || DEFAULT_IMAGE_MIME;
        results.push(buildChunk(
          chunkMeta(state),
          {
            images: [{
              type: OPENAI_BLOCK.IMAGE_URL,
              image_url: { url: encodeDataUri(mimeType, inlineData.data) }
            }]
          },
          null
        ));
      }
    }
  }

  // Usage metadata - extract before finish reason so we can include it
  const usageMeta = response.usageMetadata || chunk.usageMetadata;
  const geminiUsage = toOpenAIUsage(usageMeta, "gemini");
  if (geminiUsage) state.usage = geminiUsage;

  // Finish reason - include usage in final chunk
  if (candidate.finishReason) {
    let finishReason = toOpenAIFinish(candidate.finishReason, "gemini");
    // An aborted/error finish must NOT upgrade to tool_calls even if a functionCall
    // was emitted earlier — that would re-execute the aborted tool call.
    if (finishReason === OPENAI_FINISH.STOP && state.geminiToolCallCount > 0) {
      finishReason = OPENAI_FINISH.TOOL_CALLS;
    }

    const finalChunk = buildChunk(chunkMeta(state), {}, finishReason);

    // Include usage in final chunk for downstream translators
    if (state.usage) {
      finalChunk.usage = state.usage;
    }

    results.push(finalChunk);
    state.finishReason = finishReason;
  }

  return results.length > 0 ? results : null;
}

// Register
register(FORMATS.GEMINI, FORMATS.OPENAI, null, geminiToOpenAIResponse);
register(FORMATS.GEMINI_CLI, FORMATS.OPENAI, null, geminiToOpenAIResponse);
register(FORMATS.ANTIGRAVITY, FORMATS.OPENAI, null, geminiToOpenAIResponse);
register(FORMATS.VERTEX, FORMATS.OPENAI, null, geminiToOpenAIResponse);
