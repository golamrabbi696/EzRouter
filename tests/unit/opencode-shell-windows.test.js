/**
 * Regression for #5011: OpenCode on Windows declares its built-in tools with
 * Windows wording ("Commands run on Windows using powershell."). Treating that as
 * a foreign tool renamed the caller's `shell` to `shell_client`, which the client
 * then rejected with "No tool named shell_client".
 */
import { describe, expect, it } from "vitest";
import {
  concealFingerprintToolNames,
  OPENCODE_FINGERPRINT_TOOLS,
} from "../../open-sse/utils/opencodeFingerprint.js";

// Same schema OpenCode ships; only the platform sentence differs by OS.
function shellTool(platformSentence) {
  return {
    type: "function",
    function: {
      name: "shell",
      description: `Execute a shell command and return its output. ${platformSentence} Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.`,
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command string to execute" },
          workdir: {
            type: "string",
            description:
              "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
          },
          timeout: {
            type: "integer",
            minimum: 0,
            description:
              "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.",
          },
          background: {
            type: "boolean",
            description:
              "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  };
}

describe("concealFingerprintToolNames (#5011)", () => {
  it("keeps a Windows-worded shell tool under its own name", () => {
    const { tools, map } = concealFingerprintToolNames([
      shellTool("Commands run on Windows using powershell."),
    ]);
    expect(map.size).toBe(0);
    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe("shell");
    expect(OPENCODE_FINGERPRINT_TOOLS).toContain(tools[0].function.name);
  });

  it("rewrites the platform sentence to the wording the upstream gate expects", () => {
    const { tools } = concealFingerprintToolNames([
      shellTool("Commands run on Windows using powershell."),
    ]);
    expect(tools[0].function.description).toContain("Commands run on Linux using bash.");
    expect(tools[0].function.description).not.toContain("powershell");
  });

  it("still renames a shell tool with an unrelated definition", () => {
    const tool = shellTool("Commands run on Windows using powershell.");
    tool.function.description = "Run whatever the caller wants.";
    const { tools, map } = concealFingerprintToolNames([tool]);
    expect(map.get("shell_client")).toBe("shell");
    expect(tools[0].function.name).toBe("shell_client");
  });
});
