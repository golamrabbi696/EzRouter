import { BaseExecutor } from "./base.js";
import { DefaultExecutor } from "./default.js";
import { ClaudeExecutor } from "./claude.js";
import { GeminiExecutor } from "./gemini.js";
import { AntigravityExecutor } from "./antigravity.js";
import { KiroExecutor } from "./kiro.js";
import { QoderExecutor } from "./qoder.js";
import { CodexExecutor } from "./codex.js";
import { CursorExecutor } from "./cursor.js";
import { VertexExecutor } from "./vertex.js";
import { OpenCodeExecutor } from "./opencode.js";
import { OpenCodeGoExecutor } from "./opencode-go.js";
import { OpenCodeZenExecutor } from "./opencode-zen.js";
import { GrokWebExecutor } from "./grok-web.js";
import { GrokCliExecutor } from "./grok-cli.js";
import { PerplexityWebExecutor } from "./perplexity-web.js";
import { PerplexityAgentExecutor } from "./perplexity-agent.js";
import { KiloGatewayExecutor } from "./kilo-gateway.js";
import { KilocodeExecutor } from "./kilocode.js";
import { ClinepassExecutor } from "./clinepass.js";
import { MmfExecutor } from "./mmf.js";
import { TraeExecutor } from "./trae.js";
import { WindsurfExecutor } from "./windsurf.js";
import { VeniceExecutor } from "./venice.js";
import { IflowExecutor } from "./iflow.js";
import { DevinExecutor } from "./devin.js";
import { MimoExecutor } from "./mimo.js";
import { MimoFreeExecutor } from "./mimo-free.js";
import { KimchiExecutor } from "./kimchi.js";

const executors = {
  claude: new ClaudeExecutor(),
  gemini: new GeminiExecutor("gemini"),
  "gemini-cli": new GeminiExecutor("gemini-cli"),
  antigravity: new AntigravityExecutor(),
  ag: new AntigravityExecutor(), // Alias
  kiro: new KiroExecutor(),
  qoder: new QoderExecutor(),
  "qoderwork-cn": new QoderExecutor("qoderwork-cn"),
  codex: new CodexExecutor(),
  cursor: new CursorExecutor(),
  vertex: new VertexExecutor("vertex"),
  "vertex-partner": new VertexExecutor("vertex-partner"),
  opencode: new OpenCodeExecutor(),
  "opencode-go": new OpenCodeGoExecutor(),
  "opencode-zen": new OpenCodeZenExecutor(),
  "grok-web": new GrokWebExecutor(),
  "grok-cli": new GrokCliExecutor(),
  gcli: new GrokCliExecutor(), // Alias
  "perplexity-web": new PerplexityWebExecutor(),
  "perplexity-agent": new PerplexityAgentExecutor(),
  "kilo-gateway": new KiloGatewayExecutor(),
  kilocode: new KilocodeExecutor(),
  clinepass: new ClinepassExecutor(),
  mmf: new MmfExecutor(),
  trae: new TraeExecutor(),
  windsurf: new WindsurfExecutor(),
  venice: new VeniceExecutor(),
  iflow: new IflowExecutor(),
  devin: new DevinExecutor(),
  "devin-cli": new DevinExecutor(),
  mimo: new MimoExecutor(),
  "mimo-free": new MimoFreeExecutor(),
  kimchi: new KimchiExecutor(),
};

/**
 * Get executor for a provider
 * @param {string} provider - Provider ID
 * @returns {BaseExecutor} Executor instance
 */
export function getExecutor(provider) {
  return executors[provider] || new DefaultExecutor(provider);
}

export { BaseExecutor } from "./base.js";
export { ClaudeExecutor } from "./claude.js";
export { GeminiExecutor } from "./gemini.js";
export { AntigravityExecutor } from "./antigravity.js";
export { KiroExecutor } from "./kiro.js";
export { QoderExecutor } from "./qoder.js";
export { CodexExecutor } from "./codex.js";
export { CursorExecutor } from "./cursor.js";
export { VertexExecutor } from "./vertex.js";
export { DefaultExecutor } from "./default.js";
export { OpenCodeExecutor } from "./opencode.js";
export { OpenCodeGoExecutor } from "./opencode-go.js";
export { OpenCodeZenExecutor } from "./opencode-zen.js";
export { GrokWebExecutor } from "./grok-web.js";
export { GrokCliExecutor } from "./grok-cli.js";
export { PerplexityWebExecutor } from "./perplexity-web.js";
export { PerplexityAgentExecutor } from "./perplexity-agent.js";
export { KiloGatewayExecutor } from "./kilo-gateway.js";
export { KilocodeExecutor } from "./kilocode.js";
export { ClinepassExecutor } from "./clinepass.js";
export { MmfExecutor } from "./mmf.js";
export { TraeExecutor } from "./trae.js";
export { WindsurfExecutor } from "./windsurf.js";
export { VeniceExecutor } from "./venice.js";
export { IflowExecutor } from "./iflow.js";
export { DevinExecutor } from "./devin.js";
export { MimoExecutor } from "./mimo.js";
export { MimoFreeExecutor } from "./mimo-free.js";
export { KimchiExecutor } from "./kimchi.js";
