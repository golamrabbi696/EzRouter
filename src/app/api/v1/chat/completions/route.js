import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { withScopeAuth } from "@/middleware/scopeAuth.js";

let initialized = false;

/**
 * Initialize translators once
 */
async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

export async function POST(request) {  
  try {
    // Fallback to local handling
    await ensureInitialized();
    
    return await withScopeAuth(handleChat)(request);
  } catch (err) {
    console.error("[Route /v1/chat/completions] Unhandled error:", err?.message || err);
    return Response.json({
      error: {
        message: err?.message || "Internal server error in chat completions",
        type: "server_error",
        code: "internal_server_error"
      }
    }, { status: 500 });
  }
}

