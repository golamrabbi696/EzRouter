"use server";

import { NextResponse } from "next/server";
import { GET as claudeGet } from "../claude-settings/route";
import { GET as clineGet } from "../cline-settings/route";
import { GET as codexGet } from "../codex-settings/route";
import { GET as copilotGet } from "../copilot-settings/route";
import { GET as coworkGet } from "../cowork-settings/route";
import { GET as deepseekTuiGet } from "../deepseek-tui-settings/route";
import { GET as droidGet } from "../droid-settings/route";
import { GET as grokBuildGet } from "../grok-build-settings/route";
import { GET as hermesGet } from "../hermes-settings/route";
import { GET as jcodeGet } from "../jcode-settings/route";
import { GET as kiloGet } from "../kilo-settings/route";
import { GET as openclawGet } from "../openclaw-settings/route";
import { GET as opencodeGet } from "../opencode-settings/route";
import { GET as piGet } from "../pi-settings/route";

const STATUS_GETTERS = {
  claude: claudeGet,
  codex: codexGet,
  opencode: opencodeGet,
  droid: droidGet,
  openclaw: openclawGet,
  hermes: hermesGet,
  cowork: coworkGet,
  copilot: copilotGet,
  cline: clineGet,
  kilo: kiloGet,
  "deepseek-tui": deepseekTuiGet,
  jcode: jcodeGet,
  "grok-build": grokBuildGet,
  pi: piGet,
};

// Simple in-memory cache to reduce redundant filesystem checks on quick page switches
let cache = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5000; // 5 seconds

// Batch endpoint: gather all CLI tool statuses in one round-trip
export async function GET() {
  const now = Date.now();
  
  // Return cached result if still valid
  if (cache && now - cacheTimestamp < CACHE_TTL) {
    return NextResponse.json(cache);
  }

  const entries = await Promise.all(
    Object.entries(STATUS_GETTERS).map(async ([toolId, getter]) => {
      try {
        const res = await getter();
        const data = await res.json();
        return [toolId, data];
      } catch {
        return [toolId, null];
      }
    }),
  );
  
  const result = Object.fromEntries(entries);
  cache = result;
  cacheTimestamp = now;
  
  return NextResponse.json(result);
}
