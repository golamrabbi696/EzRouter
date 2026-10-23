// The one place that reads the client's 9router API key(s) off a request.
//
// Anthropic clients send an unrelated `Authorization: Bearer …` ALONGSIDE a
// valid `x-api-key` (Claude Code does this whenever it has a claude.ai session
// or ANTHROPIC_AUTH_TOKEN set). api.anthropic.com authenticates on x-api-key
// regardless, so a gateway that reads only the first header 401s a valid key.
// Every presented credential is therefore a CANDIDATE, and callers decide per
// candidate.
//
// Used by the middleware (src/dashboardGuard.js), the /v1 handlers
// (src/sse/services/auth.js resolveClientApiKey), the Gemini-native /v1beta
// route and the per-key access engine (src/sse/services/keyAccess.js), so what
// authenticates a request and what restricts it can never be read from
// different places.
//
// Pure: no DB, no Next.js imports, safe in the middleware.

/**
 * Every client credential the request presents, in precedence order:
 * `Authorization: Bearer <k>`, `x-api-key`, `x-goog-api-key`, `?key=`.
 * Empty values are skipped and duplicates collapsed. The Bearer scheme is
 * matched exactly as before ("Bearer " — no other scheme or spelling is read).
 * Values are NOT trimmed or otherwise rewritten: a candidate only ever matches
 * a stored key byte for byte.
 * @param {Request|import("next/server").NextRequest} request
 * @returns {string[]}
 */
export function extractApiKeyCandidates(request) {
  const headers = request?.headers;
  if (!headers?.get) return [];
  const candidates = [];
  const push = (value) => {
    if (typeof value === "string" && value && !candidates.includes(value)) candidates.push(value);
  };
  const auth = headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) push(auth.slice(7));
  push(headers.get("x-api-key"));
  push(headers.get("x-goog-api-key"));
  push(queryKey(request));
  return candidates;
}

function queryKey(request) {
  const fromNext = request.nextUrl?.searchParams;
  if (fromNext?.get) return fromNext.get("key");
  try {
    return new URL(request.url).searchParams.get("key");
  } catch {
    return null;
  }
}
