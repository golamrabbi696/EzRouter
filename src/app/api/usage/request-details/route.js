import { NextResponse } from "next/server";
import { getRequestDetails } from "@/lib/usageDb";
import { prepareRequestDetailsResponse } from "@/lib/requestDetailsVisibility";
import { getApiKeys } from "@/lib/localDb";

function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  if (key.length <= 12) return key.charAt(0) + "***";
  return key.slice(0, 8) + "***" + key.slice(-4);
}

/**
 * GET /api/usage/request-details
 * Query parameters: page, pageSize (1-100), provider, model, connectionId, status, startDate, endDate
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    
    const pageRaw = parseInt(searchParams.get("page"));
    const page = Number.isNaN(pageRaw) ? 1 : pageRaw;
    const pageSizeRaw = parseInt(searchParams.get("pageSize"));
    const pageSize = Number.isNaN(pageSizeRaw) ? 20 : pageSizeRaw;
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    const connectionId = searchParams.get("connectionId");
    const status = searchParams.get("status");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    
    if (page < 1) {
      return NextResponse.json(
        { error: "Page must be >= 1" },
        { status: 400 }
      );
    }
    
    if (pageSize < 1 || pageSize > 100) {
      return NextResponse.json(
        { error: "PageSize must be between 1 and 100" },
        { status: 400 }
      );
    }
    
    const filter = {
      page,
      pageSize
    };
    
    if (provider) filter.provider = provider;
    if (model) filter.model = model;
    if (connectionId) filter.connectionId = connectionId;
    if (status) filter.status = status;
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;
    
    const [result, apiKeys] = await Promise.all([
      getRequestDetails(filter),
      getApiKeys().catch(() => [])
    ]);

    const keyMap = new Map();
    for (const k of apiKeys || []) {
      if (k?.key) keyMap.set(k.key, k);
    }

    const enrichedDetails = (result.details || []).map((d) => {
      const enriched = { ...d };
      if (enriched.apiKey) {
        const matched = keyMap.get(enriched.apiKey);
        enriched.apiKeyName = matched?.name || null;
        enriched.apiKey = maskApiKey(enriched.apiKey);
      } else {
        enriched.apiKey = null;
        enriched.apiKeyName = "Local / No Key";
      }
      return enriched;
    });

    // Conversation payloads stay redacted by default. Server operators may
    // explicitly opt in to exposing stored prompts and responses in the
    // dashboard with SHOW_REQUEST_PAYLOADS=true or ENABLE_PROMPT_LOGGING=true.
    return NextResponse.json(prepareRequestDetailsResponse({ ...result, details: enrichedDetails }));
  } catch (error) {
    console.error("[API] Failed to get request details:", error);
    return NextResponse.json(
      { error: "Failed to fetch request details" },
      { status: 500 }
    );
  }
}
