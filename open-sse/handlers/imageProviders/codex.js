// Codex (ChatGPT Plus/Pro) image generation via Responses API + SSE
import { randomUUID } from "node:crypto";
import { nowSec } from "./_base.js";
import { PROVIDERS } from "../../config/providers.js";
import { resolveCodexAccountId } from "../../services/codexAccount.js";
import {
  CODEX_CLI_VERSION,
  CODEX_IMAGE_ERROR_TEXT_LIMIT,
  CODEX_IMAGE_NO_RESULT_ERROR,
} from "../../config/codexConstants.js";

import { detectImageMime, encodeDataUri, parseDataUri } from "../../translator/concerns/image.js";

const CODEX_RESPONSES_URL = PROVIDERS["codex"].baseUrl;
const CODEX_USER_AGENT = `codex_cli_rs/${CODEX_CLI_VERSION}`;
const CODEX_VERSION = CODEX_CLI_VERSION;
const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_MODEL_SUFFIX = "-image";
const CODEX_REF_DETAIL = "high";
const CODEX_IMAGES_MAIN_MODEL = "gpt-5.5";
const CODEX_TOOL_IMAGE_MODELS = new Set([
  "gpt-image-1.5",
  "gpt-image-2",
  "gpt-image-2.5",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
]);

function stripImageSuffix(model) {
  return model.endsWith(CODEX_MODEL_SUFFIX) ? model.slice(0, -CODEX_MODEL_SUFFIX.length) : model;
}

function resolveCodexImageModels(model) {
  if (CODEX_TOOL_IMAGE_MODELS.has(model)) {
    return { responsesModel: CODEX_IMAGES_MAIN_MODEL, toolModel: model };
  }
  return { responsesModel: stripImageSuffix(model), toolModel: null };
}

function decodeBase64Image(input) {
  const normalized = String(input || "").replace(/\s+/g, "");
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    return null;
  }

  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const buffer = Buffer.from(padded, "base64");
  if (!buffer.length) return null;

  const canonical = buffer.toString("base64").replace(/=+$/, "");
  if (canonical !== normalized.replace(/=+$/, "")) return null;

  const mimeType = detectImageMime(buffer);
  return mimeType ? { base64: buffer.toString("base64"), mimeType } : null;
}

function toDataUrl(input, label) {
  if (!input || typeof input !== "string") {
    throw new Error(`Invalid reference image at ${label}. Use an image URL, image data URL, or raw image base64.`);
  }

  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  const parsed = parseDataUri(trimmed);
  if (parsed?.mimeType?.startsWith("image/")) {
    const decoded = decodeBase64Image(parsed.base64);
    if (decoded) return encodeDataUri(decoded.mimeType, decoded.base64);
  }

  const decoded = decodeBase64Image(trimmed);
  if (decoded) return encodeDataUri(decoded.mimeType, decoded.base64);

  throw new Error(`Invalid reference image at ${label}. Use an image URL, image data URL, or raw image base64.`);
}

function buildContent(prompt, refs, detail = CODEX_REF_DETAIL) {
  const content = [];
  refs.forEach((url, index) => {
    content.push({ type: "input_text", text: `<image name=image${index + 1}>` });
    content.push({ type: "input_image", image_url: url, detail });
    content.push({ type: "input_text", text: "</image>" });
  });
  content.push({ type: "input_text", text: prompt });
  return content;
}

// Parse Codex SSE stream → final base64 image. Optional callbacks for client streaming.
async function parseStream(response, log, callbacks = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let imageB64 = null;
  let outputText = "";
  let lastEvent = null;
  let bytesReceived = 0;
  let lastProgressLogMs = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesReceived += value?.byteLength || 0;
    buffer += decoder.decode(value, { stream: true });

    let sepIdx;
    while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);

      const lines = block.split("\n");
      let eventName = null;
      let dataStr = "";
      for (const line of lines) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
      }
      if (!eventName) continue;
      let data;
      try { data = JSON.parse(dataStr); } catch { /* Ignore non-JSON SSE frames. */ }
      // HTTP 200 can carry an upstream failure. Preserve its reason so callers
      // can distinguish client-version, quota and content errors from no output.
      const failed = eventName === "error" || eventName === "response.failed" ||
        data?.response?.status === "failed" || data?.response?.status === "incomplete";
      if (failed) {
        const error = data?.response?.error || data?.error;
        const message = error?.message || (typeof error === "string" ? error : null) ||
          data?.message || data?.response?.incomplete_details?.reason || "Codex image response failed.";
        await reader.cancel().catch(() => {});
        throw new Error(message);
      }
      if (eventName !== lastEvent) {
        log?.info?.("IMAGE", `codex progress: ${eventName}`);
        lastEvent = eventName;
      }

      const now = Date.now();
      if (callbacks.onProgress && now - lastProgressLogMs > 200) {
        lastProgressLogMs = now;
        callbacks.onProgress({ stage: eventName, bytesReceived });
      }

      if (eventName === "response.image_generation_call.partial_image" && dataStr) {
        try {
          if (callbacks.onPartialImage && data?.partial_image_b64) {
            callbacks.onPartialImage({ b64_json: data.partial_image_b64, index: data.partial_image_index });
          }
        } catch {}
      }

      if (eventName === "response.output_item.done" && dataStr) {
        try {
          const item = data?.item;
          if (item?.type === "image_generation_call" && item.result) {
            imageB64 = item.result;
          }
          if (item?.type === "message" && Array.isArray(item.content)) {
            outputText += item.content.map((part) => part.refusal || part.text || "").join(" ");
            outputText = outputText.slice(0, CODEX_IMAGE_ERROR_TEXT_LIMIT);
          }
        } catch {}
      }
    }
  }
  if (!imageB64 && outputText) throw new Error(`${CODEX_IMAGE_NO_RESULT_ERROR} ${outputText}`);
  return imageB64;
}

// SSE Response that pipes codex progress + partial + done events to client
function buildSseResponse(providerResponse, log, onSuccess) {
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event, data) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        const b64 = await parseStream(providerResponse, log, {
          onProgress: (info) => send("progress", info),
          onPartialImage: (info) => send("partial_image", info),
        });
        if (!b64) {
          send("error", { message: CODEX_IMAGE_NO_RESULT_ERROR });
        } else {
          if (onSuccess) await onSuccess();
          send("done", { created: nowSec(), data: [{ b64_json: b64 }] });
        }
      } catch (err) {
        send("error", { message: err?.message || "Stream failed" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export default {
  stream: true,
  buildUrl: () => CODEX_RESPONSES_URL,
  buildHeaders: (creds) => {
    const accountId = resolveCodexAccountId(creds?.providerSpecificData, creds?.idToken);
    return {
      "accept": "text/event-stream, application/json",
      "authorization": `Bearer ${creds?.accessToken || ""}`,
      "chatgpt-account-id": accountId || "",
      "content-type": "application/json",
      "originator": CODEX_ORIGINATOR,
      "session_id": randomUUID(),
      "user-agent": CODEX_USER_AGENT,
      "version": CODEX_CLI_VERSION,
      "x-client-request-id": randomUUID(),
    };
  },
  buildBody: (model, body) => {
    const refs = [];
    if (Array.isArray(body.images)) {
      body.images.forEach((image, index) => refs.push(toDataUrl(image, `images[${index}]`)));
    }
    if (body.image != null && body.image !== "") {
      refs.push(toDataUrl(body.image, "image"));
    }
    const detail = body.image_detail || CODEX_REF_DETAIL;
    const { responsesModel, toolModel } = resolveCodexImageModels(model);
    const imgTool = { type: "image_generation", output_format: (body.output_format || "png").toLowerCase() };
    if (toolModel) {
      imgTool.action = refs.length > 0 ? "edit" : "generate";
      imgTool.model = toolModel;
    }
    if (body.size && body.size !== "") imgTool.size = body.size;
    if (body.quality && body.quality !== "") imgTool.quality = body.quality;
    if (body.background && body.background !== "") imgTool.background = body.background;
    if (body.moderation) imgTool.moderation = body.moderation;
    if (Number.isFinite(Number(body.output_compression))) imgTool.output_compression = Number(body.output_compression);
    if (Number.isFinite(Number(body.partial_images))) imgTool.partial_images = Number(body.partial_images);
    return {
      model: responsesModel,
      instructions: "",
      input: [{ type: "message", role: "user", content: buildContent(body.prompt, refs, detail) }],
      tools: [imgTool],
      // /images/generations must produce an image even when the prompt could be answered as text.
      tool_choice: toolModel ? { type: "image_generation" } : "required",
      parallel_tool_calls: false,
      prompt_cache_key: randomUUID(),
      stream: true,
      store: false,
      reasoning: toolModel ? { effort: "medium", summary: "auto" } : null,
    };
  },
  // Custom: codex parses SSE → either pipe to client or collect b64
  async parseResponse(response, { log, streamToClient, onRequestSuccess }) {
    if (streamToClient) {
      return { sseResponse: buildSseResponse(response, log, onRequestSuccess) };
    }
    const b64 = await parseStream(response, log);
    if (!b64) {
      throw new Error(CODEX_IMAGE_NO_RESULT_ERROR);
    }
    return { created: nowSec(), data: [{ b64_json: b64 }] };
  },
  normalize: (responseBody) => responseBody,
};
