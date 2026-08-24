import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import { fetchOidcDiscovery, getPublicOrigin, probeOidcClientSecret } from "@/lib/auth/oidc";
import { AUTH_COOKIE_NAME, verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { assertPublicUrl } from "@/shared/utils/ssrfGuard";

async function canAccessTestRoute() {
  const settings = await getSettings();
  if (settings.requireLogin === false) return true;

  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value || cookieStore.get("auth_token")?.value;
  return await verifyDashboardAuthToken(token);
}

export async function POST(request) {
  try {
    if (!(await canAccessTestRoute())) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const settings = await getSettings();

    const issuerUrl = String(body.issuerUrl || settings.oidcIssuerUrl || "").trim();
    const clientId = String(body.clientId || settings.oidcClientId || "").trim();
    const clientSecret = String(body.clientSecret || settings.oidcClientSecret || "").trim();

    if (!issuerUrl) {
      return NextResponse.json({ error: "Issuer URL is required" }, { status: 400 });
    }
    if (!clientId) {
      return NextResponse.json({ error: "Client ID is required" }, { status: 400 });
    }

    // SSRF guard: reject internal/private/metadata targets
    try {
      assertPublicUrl(issuerUrl);
    } catch (err) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    const discovery = await fetchOidcDiscovery(issuerUrl);
    const redirectUri = `${getPublicOrigin(request)}/api/auth/oidc/callback`;
    const secretProbe = await probeOidcClientSecret({
      issuerUrl,
      tokenEndpoint: discovery?.token_endpoint,
      clientId,
      clientSecret,
      redirectUri,
    });

    return NextResponse.json({
      success: true,
      discovery: {
        issuer: discovery?.issuer,
        authorizationEndpoint: discovery?.authorization_endpoint,
        tokenEndpoint: discovery?.token_endpoint,
        userinfoEndpoint: discovery?.userinfo_endpoint,
        jwksUri: discovery?.jwks_uri,
      },
      clientSecretProbe: secretProbe,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error.message || "OIDC discovery failed",
        code: error.code || null,
        details: error.details || null,
      },
      { status: 400 }
    );
  }
}
