import { describe, it, expect } from "vitest";
import {
  applyFingerprintTools,
  concealFingerprintToolNames,
  appendMissingFingerprintTools,
  fingerprintToolKey,
  restoreToolNames,
  takeRenamedToolNames,
  OPENCODE_FINGERPRINT_TOOLS,
} from "open-sse/utils/opencodeFingerprint.js";

const CC_TOOLS = ["Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write", "WebFetch"];
const flat = (names) => names.map((name) => ({ type: "function", name }));
const chat = (names) => names.map((name) => ({ type: "function", function: { name } }));
const namesOf = (tools) => tools.map((tool) => tool.name ?? tool.function?.name);

describe("opencodeFingerprint — request side", () => {
  it("appends exact read/shell definitions and leaves case variants untouched", () => {
    const body = { tools: flat(CC_TOOLS) };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual([...CC_TOOLS, ...OPENCODE_FINGERPRINT_TOOLS]);
    expect(map.size).toBe(0);
    const shell = body.tools.find((tool) => tool.name === "shell");
    expect(shell.description).toMatch(/^Execute a shell command/);
    expect(shell.parameters.required).toEqual(["command"]);
    expect(shell.strict).toBe(false);
  });

  it("handles the nested chat shape without dropping .function", () => {
    const body = { tools: chat(["Edit"]) };
    applyFingerprintTools(body, false);

    expect(namesOf(body.tools)).toEqual(["Edit", "read", "shell"]);
    const read = body.tools.find((tool) => tool.function?.name === "read");
    expect(read.function.parameters.required).toEqual(["path"]);
  });

  it("aliases a caller tool that reuses an exact fingerprint name", () => {
    const body = { tools: flat(["read", "read_client", "Edit"]) };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual(["read_client2", "read_client", "Edit", "read", "shell"]);
    expect(map.get("read_client2")).toBe("read");
  });

  it("keeps a caller tool that already carries OpenCode's exact definition", () => {
    const first = { tools: [] };
    applyFingerprintTools(first, true);
    const official = first.tools.map((tool) => ({ ...tool }));

    const body = { tools: official };
    const map = applyFingerprintTools(body, true);
    expect(namesOf(body.tools)).toEqual(OPENCODE_FINGERPRINT_TOOLS);
    expect(map.size).toBe(0);
    expect(body.instructions).toBeUndefined();
  });

  it("drops duplicate declarations of one fingerprint name", () => {
    const body = { tools: flat(["shell", "shell"]) };
    applyFingerprintTools(body, true);
    expect(namesOf(body.tools)).toEqual(["shell_client", "read", "shell"]);
  });

  it("defaults Responses tool_choice to auto and never to none for chat", () => {
    const responses = { tools: [] };
    applyFingerprintTools(responses, true);
    expect(responses.tool_choice).toBe("auto");

    const chatBody = { messages: [{ role: "user", content: "hi" }] };
    applyFingerprintTools(chatBody, false);
    expect(namesOf(chatBody.tools)).toEqual(OPENCODE_FINGERPRINT_TOOLS);
    expect(chatBody.tool_choice).toBeUndefined();
  });

  it("tells the model the appended tools are placeholders", () => {
    const responses = { instructions: "Be brief.", tools: [] };
    applyFingerprintTools(responses, true);
    expect(responses.instructions).toMatch(/^Be brief\.\n\nDo not call the `read` or `shell` tools;/);

    const chatBody = { messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }] };
    applyFingerprintTools(chatBody, false);
    expect(chatBody.messages).toHaveLength(2);
    expect(chatBody.messages[0].content).toMatch(/^Be brief\.\n\nDo not call the `read` or `shell` tools;/);

    const noSystem = { messages: [{ role: "user", content: "hi" }] };
    applyFingerprintTools(noSystem, false);
    expect(noSystem.messages[0]).toEqual({ role: "system", content: expect.stringMatching(/^Do not call/) });

    const claudeShape = { system: "Be brief.", messages: [{ role: "user", content: "hi" }] };
    applyFingerprintTools(claudeShape, false);
    expect(claudeShape.messages).toHaveLength(1);
  });

  it("retargets flat tool_choice that points at an aliased tool", () => {
    const body = { tools: flat(["shell"]), tool_choice: { type: "function", name: "shell" } };
    applyFingerprintTools(body, true);
    expect(body.tool_choice.name).toBe("shell_client");
  });

  it("retargets nested tool_choice that points at an aliased tool", () => {
    const body = {
      tools: chat(["read"]),
      tool_choice: { type: "function", function: { name: "read" } },
    };
    applyFingerprintTools(body, false);
    expect(body.tool_choice.function.name).toBe("read_client");
  });

  it("records the rename map against the body for the response side", () => {
    const body = { tools: flat(["read"]) };
    const map = applyFingerprintTools(body, true);
    expect(takeRenamedToolNames(body)).toBe(map);
  });

  it("canonicalises history tool_calls in messages and converts snake_case to camelCase", () => {
    const body = {
      tools: flat(["Edit"]),
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              function: {
                name: "Edit",
                arguments: JSON.stringify({ file_path: "/test.txt", old_string: "a", new_string: "b", replace_all: true }),
              },
            },
          ],
        },
      ],
    };
    applyFingerprintTools(body, true);
    const tc = body.messages[0].tool_calls[0].function;
    expect(tc.name).toBe("edit");
    const args = JSON.parse(tc.arguments);
    expect(args.filePath).toBe("/test.txt");
    expect(args.oldString).toBe("a");
    expect(args.newString).toBe("b");
    expect(args.replaceAll).toBe(true);
    expect(args.file_path).toBeUndefined();
  });

  it("never throws on malformed tools", () => {
    for (const tools of [null, undefined, "nope", [null, 42, []], [{}, { name: "" }]]) {
      expect(() => concealFingerprintToolNames(tools)).not.toThrow();
      expect(() => appendMissingFingerprintTools(tools, true)).not.toThrow();
    }
  });
});

describe("opencodeFingerprint — response side", () => {
  const map = new Map([["bash", "Bash"], ["grep", "Grep"], ["read", "Read"], ["edit", "Edit"]]);

  it("restores names in Claude content_block_start chunks", () => {
    const chunk = {
      type: "content_block_start",
      content_block: { type: "tool_use", name: "bash", id: "t1" },
    };
    const out = restoreToolNames(chunk, map);

    expect(out.content_block.name).toBe("Bash");
    expect(chunk.content_block.name).toBe("bash");
  });

  it("recursively restores streaming chunks inside arrays", () => {
    const chunks = [{
      choices: [{ delta: { tool_calls: [{ function: { name: "grep", arguments: "{}" } }] } }],
    }];
    const out = restoreToolNames(chunks, map);
    expect(out[0].choices[0].delta.tool_calls[0].function.name).toBe("Grep");
  });

  it("restores names and normalizes arguments in Claude non-streaming bodies", () => {
    const body = {
      type: "message",
      content: [
        {
          type: "tool_use",
          name: "edit",
          input: { filePath: "/path/to/file", oldString: "old", newString: "new", replaceAll: true },
        },
      ],
    };
    const out = restoreToolNames(body, map);
    expect(out.content[0].name).toBe("Edit");
    expect(out.content[0].input.file_path).toBe("/path/to/file");
    expect(out.content[0].input.old_string).toBe("old");
    expect(out.content[0].input.new_string).toBe("new");
    expect(out.content[0].input.replace_all).toBe(true);
    expect(out.content[0].input.filePath).toBeUndefined();
  });

  it("restores names and normalizes arguments in Chat Completions message shapes", () => {
    const body = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "edit",
                  arguments: JSON.stringify({ filePath: "/path/file", oldString: "a", newString: "b" }),
                },
              },
            ],
          },
        },
        { delta: { tool_calls: [{ function: { name: "read", arguments: "{}" } }] } },
      ],
    };
    const out = restoreToolNames(body, map);

    expect(out.choices[0].message.tool_calls[0].function.name).toBe("Edit");
    const parsedArgs = JSON.parse(out.choices[0].message.tool_calls[0].function.arguments);
    expect(parsedArgs.file_path).toBe("/path/file");
    expect(parsedArgs.old_string).toBe("a");
    expect(parsedArgs.new_string).toBe("b");
    expect(parsedArgs.filePath).toBeUndefined();
    expect(out.choices[1].delta.tool_calls[0].function.name).toBe("Read");
  });

  it("restores names in Responses final output items", () => {
    const body = { output: [{ type: "function_call", name: "bash", call_id: "c1" }] };
    expect(restoreToolNames(body, map).output[0].name).toBe("Bash");
  });

  it("restores names in Responses streaming output_item events", () => {
    const event = {
      type: "response.output_item.added",
      item: { type: "function_call", name: "read", call_id: "c1" },
    };
    expect(restoreToolNames(event, map).item.name).toBe("Read");
  });

  it("is a no-op without a map or with an empty map", () => {
    const body = { choices: [{ message: { tool_calls: [{ function: { name: "bash" } }] } }] };
    expect(restoreToolNames(body, null)).toBe(body);
    expect(restoreToolNames(body, new Map())).toBe(body);
  });

  it("leaves unknown tool names untouched", () => {
    const body = { output: [{ type: "function_call", name: "Edit" }] };
    expect(restoreToolNames(body, map).output[0].name).toBe("Edit");
  });
});

describe("fingerprintToolKey", () => {
  it("matches exact fingerprint names only", () => {
    expect(fingerprintToolKey("read")).toBe("read");
    expect(fingerprintToolKey(" shell ")).toBe("shell");
    expect(fingerprintToolKey("Read")).toBe("");
    expect(fingerprintToolKey("bash")).toBe("");
    expect(fingerprintToolKey("terminal")).toBe("");
    expect(fingerprintToolKey(null)).toBe("");
  });
});
