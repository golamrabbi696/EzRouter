import { NextResponse } from "next/server";
import { resolveKiroCredentialsFromCache } from "@/lib/oauth/kiroSsoCache";
import { assertValidAwsRegion } from "@/lib/oauth/constants/oauth";
import { hasValidCliToken, isAuthenticated } from "@/dashboardGuard";

async function requireAuth(request) {
  if (await hasValidCliToken(request) || await isAuthenticated(request)) return true;
  return false;
}

/**
 * GET /api/oauth/kiro/auto-import
 * Auto-detect and extract Kiro refresh token from AWS SSO cache.
 * For IDC (organization) tokens, also resolves clientId/clientSecret from the
 * linked client registration file so token refresh works.
 */
export async function GET(request) {
  if (!(await requireAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const credentials = await resolveKiroCredentialsFromCache();

    // Validate region before returning (SSRF prevention)
    let safeRegion = credentials.region || "us-east-1";
    try {
      assertValidAwsRegion(safeRegion);
    } catch {
      safeRegion = "us-east-1";
    }

    return NextResponse.json({
      found: true,
      refreshToken: credentials.refreshToken,
      source: credentials.source,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      region: safeRegion,
      authMethod: credentials.authMethod,
      profileArn: credentials.profileArn,
      ...(credentials.rawAuth ? { rawAuth: credentials.rawAuth } : {}),
    });
  } catch (error) {
    console.log("Kiro auto-import error:", error);
    return NextResponse.json(
      { found: false, error: error.message },
      { status: 500 }
    );
  }
}
