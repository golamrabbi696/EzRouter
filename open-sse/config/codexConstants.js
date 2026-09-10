import { CODEX_CLI_VERSION } from "./appConstants.js";

export { CODEX_CLI_VERSION };
export const CODEX_CLIENT_VERSION = CODEX_CLI_VERSION;
export const CODEX_USER_AGENT = `codex_cli_rs/${CODEX_CLI_VERSION}`;

export const CODEX_IMAGE_NO_RESULT_ERROR = "Codex completed without returning an image.";
export const CODEX_IMAGE_ERROR_TEXT_LIMIT = 1000;
