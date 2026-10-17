"use server";

import { NextResponse } from "next/server";
import { resolveCliApiKey } from "../resolveApiKey.js";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { resolveModelDisplayName } from "@/shared/utils/modelDisplayName";

const execAsync = promisify(exec);

const getConfigDir = () => path.join(os.homedir(), ".config", "opencode");
const getConfigPath = () => path.join(getConfigDir(), "opencode.json");

// Check if opencode CLI is installed (via which/where or config file exists)
const checkOpenCodeInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where opencode" : "which opencode";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

const readConfig = async () => {
  try {
    const content = await fs.readFile(getConfigPath(), "utf-8");
    // opencode config files are JSONC: comments and trailing commas are allowed.
    // Strip comments first — string-aware, so "https://..." survives — then
    // trailing commas, otherwise JSON.parse throws and callers treat the file as
    // absent (POST would then rewrite it and drop mcp/plugins/model).
    const withoutComments = content.replace(
      /("(?:\\.|[^"\\])*")|\/\/[^\n\r]*|\/\*[\s\S]*?\*\//g,
      (match, stringLiteral) => stringLiteral ?? "",
    );
    const stripped = withoutComments.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    // If the config file exists but is unparseable (corrupted, exotic JSONC),
    // treat it as "no config" rather than throwing a 500 that the UI
    // misinterprets as "opencode not installed".
    return null;
  }
};

const has9RouterConfig = (config) => {
  // Support both V2 (providers) and legacy V1 (provider)
  if (config?.providers?.["9router"]) return true;
  if (config?.provider?.["9router"]) return true;
  return false;
};

// V2-native provider id package. opencode V2 resolves the provider implementation
// from this exact registered package id (hyphen form). The slash form
// `.../openai-compatible/responses` is a DIFFERENT entry that does not select the
// Responses transport, so the request degraded to /chat/completions.
const OPENCODE_PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible-responses";

// Read the 9router provider entry regardless of config schema version.
const getProviderEntry = (config) =>
  config?.providers?.["9router"] || config?.provider?.["9router"] || null;

// Write the 9router provider entry in V2 form, dropping any legacy V1 entry.
const setProviderEntry = (config, entry) => {
  if (!config.providers) config.providers = {};
  config.providers["9router"] = entry;
  if (config.provider) {
    delete config.provider["9router"];
    // Drop the V1 key entirely once it holds nothing, so a migrated config does
    // not keep a stray `"provider": {}` block around.
    if (Object.keys(config.provider).length === 0) delete config.provider;
  }
};

// Remove the 9router provider entry from both schema versions.
const deleteProviderEntry = (config) => {
  if (config.providers) {
    delete config.providers["9router"];
    if (Object.keys(config.providers).length === 0) delete config.providers;
  }
  if (config.provider) {
    delete config.provider["9router"];
    if (Object.keys(config.provider).length === 0) delete config.provider;
  }
};

// Read the configured baseURL regardless of config schema version.
const getProviderBaseURL = (config) => {
  const entry = getProviderEntry(config);
  return entry?.settings?.baseURL || entry?.options?.baseURL || null;
};

// GET - Check opencode CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkOpenCodeInstalled();

    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "OpenCode CLI is not installed",
      });
    }

    const config = await readConfig();

    // Support both V2 (providers) and V1 (provider) formats
    const providerEntry = getProviderEntry(config);
    const modelMap = providerEntry?.models || {};

    return NextResponse.json({
      installed: true,
      config,
      has9Router: has9RouterConfig(config),
      configPath: getConfigPath(),
        opencode: {
          models: Object.keys(modelMap),
          activeModel: config?.model?.startsWith("9router/") ? config.model.replace(/^9router\//, "") : null,
          baseURL: getProviderBaseURL(config),
        },
    });
  } catch (error) {
    console.log("Error checking opencode settings:", error);
    return NextResponse.json({ error: "Failed to check opencode settings" }, { status: 500 });
  }
}

// POST - Apply 9Router as openai-compatible provider (multi-model support)
export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, models, activeModel, subagentModel } = await request.json();

    // Accept either `model` (string, legacy) or `models` (array of strings)
    const modelsArray = Array.isArray(models) ? models.slice() : (typeof model === "string" ? [model] : []);

    if (!baseUrl || modelsArray.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }

    const configDir = getConfigDir();
    const configPath = getConfigPath();

    await fs.mkdir(configDir, { recursive: true });

    // Read existing config or start fresh. Reuse readConfig() so a JSONC file
    // (comments / trailing commas) parses instead of being silently replaced by
    // a fresh config, which would drop the user's mcp/plugins/model entries.
    let config = (await readConfig()) || {};

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const keyToUse = await resolveCliApiKey(apiKey);
    const effectiveSubagentModel = subagentModel || modelsArray[0];

    // Preserve any existing 9router provider entry and its models (either schema)
    const existingEntry = getProviderEntry(config) || {};
    const existingModels = existingEntry.models || {};

    const nextModels = { ...existingModels };
    for (const m of modelsArray) {
      if (!m || typeof m !== "string") continue;
      nextModels[m] = {
        name: resolveModelDisplayName(m),
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      };
    }

    // Write V2-native provider entry (legacy V1 entry is dropped)
    setProviderEntry(config, {
      name: "9router",
      package: OPENCODE_PROVIDER_PACKAGE,
      env: ["ROUTER9_API_KEY"],
      settings: {
        baseURL: normalizedBaseUrl,
        apiKey: keyToUse,
      },
      models: nextModels,
    });

    // Set the active model: prefer explicit activeModel, else first of modelsArray
    // If activeModel is explicitly empty string, clear the model
    if (activeModel === "") {
      config.model = "";
    } else {
      const finalActive = activeModel || modelsArray[0];
      if (finalActive) {
        config.model = `9router/${finalActive}`;
      }
    }

    // Add subagent configuration (V2: `agents`)
    if (!config.agents) config.agents = {};
    config.agents.explorer = {
      description: "Fast explorer subagent for codebase exploration",
      mode: "subagent",
      model: `9router/${effectiveSubagentModel}`,
    };

    // Drop the legacy V1 agent entry we used to write
    if (config.agent?.explorer) {
      delete config.agent.explorer;
      if (Object.keys(config.agent).length === 0) delete config.agent;
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: "OpenCode settings applied successfully!",
      configPath,
    });
  } catch (error) {
    console.log("Error applying opencode settings:", error);
    return NextResponse.json({ error: "Failed to apply settings" }, { status: 500 });
  }
}

// PATCH - Update specific settings (e.g., clear active model)
export async function PATCH(request) {
  try {
    const { clearActiveModel } = await request.json();
    const configPath = getConfigPath();

    let config = {};
    try {
      const existing = await fs.readFile(configPath, "utf-8");
      config = JSON.parse(existing);
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({ success: true, message: "No config file found" });
      }
      throw error;
    }

    if (clearActiveModel === true) {
      // Clear active model but keep models in the list
      if (config.model?.startsWith("9router/")) {
        config.model = "";
      }
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: "Settings updated",
    });
  } catch (error) {
    console.log("Error patching opencode settings:", error);
    return NextResponse.json({ error: "Failed to patch settings" }, { status: 500 });
  }
}

// DELETE - Remove 9Router provider or specific models from config
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const modelToRemove = searchParams.get("model");
    const configPath = getConfigPath();

    let config = {};
    try {
      const existing = await fs.readFile(configPath, "utf-8");
      config = JSON.parse(existing);
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({ success: true, message: "No config file to reset" });
      }
      throw error;
    }

    // If specific model provided, remove just that model
    const providerEntry = getProviderEntry(config);
    if (modelToRemove && providerEntry?.models) {
      delete providerEntry.models[modelToRemove];

      // If no models left, remove the provider
      if (Object.keys(providerEntry.models).length === 0) {
        deleteProviderEntry(config);
        if (config.model?.startsWith("9router/")) delete config.model;
      } else if (config.model === `9router/${modelToRemove}`) {
        // If removed model was active, switch to first remaining model
        const remainingModels = Object.keys(providerEntry.models);
        config.model = `9router/${remainingModels[0]}`;
      }
    } else {
      // No specific model - remove entire 9router provider
      deleteProviderEntry(config);
      if (config.model?.startsWith("9router/")) delete config.model;
    }

    // Remove subagent configuration (V2 `agents` and legacy `agent`)
    if (config.agents?.explorer?.model?.startsWith("9router/")) {
      delete config.agents.explorer;
      if (Object.keys(config.agents).length === 0) delete config.agents;
    }
    if (config.agent?.explorer?.model?.startsWith("9router/")) {
      delete config.agent.explorer;
      // Clean up empty agent object
      if (Object.keys(config.agent).length === 0) delete config.agent;
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: modelToRemove ? `Model "${modelToRemove}" removed` : "9Router settings removed from OpenCode",
    });
  } catch (error) {
    console.log("Error resetting opencode settings:", error);
    return NextResponse.json({ error: "Failed to reset opencode settings" }, { status: 500 });
  }
}
