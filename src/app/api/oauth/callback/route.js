import { NextResponse } from "next/server";
import {
  getOAuthSessionStatus,
  updateOAuthSession,
  performSynchronizedExchange,
} from "@/lib/oauth/utils/server";

export async function POST(request) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { state, code, token, error, errorDescription } = body;

    if (!state && !code && !token) {
      return NextResponse.json({ error: "Missing state or code/token" }, { status: 400 });
    }

    const session = state ? getOAuthSessionStatus(state) : null;

    if (error) {
      const errMsg = errorDescription || error;
      if (session) {
        updateOAuthSession(state, { status: "error", error: errMsg });
      }
      return NextResponse.json({ success: false, error: errMsg }, { status: 400 });
    }

    const provider = session?.provider || "antigravity";
    const urlOrigin = new URL(request.url).origin;
    const redirectUri = session?.redirectUri || `${urlOrigin}/callback`;
    const codeVerifier = session?.codeVerifier || null;
    const meta = session?.meta || null;

    try {
      const result = await performSynchronizedExchange(
        provider,
        code || token,
        redirectUri,
        codeVerifier,
        state,
        meta
      );

      return NextResponse.json(result);
    } catch (err) {
      return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
