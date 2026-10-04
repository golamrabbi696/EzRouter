import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { transform, loadBindings } = require("next/dist/build/swc");
await loadBindings();
const source = readFileSync(new URL("../../src/shared/components/PingNowButton.js", import.meta.url), "utf8");
const { code } = await transform(source, {
  filename: "PingNowButton.js",
  jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
  module: { type: "commonjs" },
});

it.each(["succeeded", "failed", "skipped", "network"])("shows %s result and requires reset before another ping", async (status) => {
  const slots = [];
  let cursor = 0;
  let finish;
  const fetch = vi.fn(() => new Promise((resolve, reject) => {
    finish = () => status === "network" ? reject(new Error("Network failed")) : resolve({ ok: true, json: async () => ({ status, message: "Provider result" }) });
  }));
  const componentModule = { exports: {} };
  runInNewContext(code, {
    exports: componentModule.exports, module: componentModule, fetch,
    require: (name) => {
      if (name === "react") return { useState: (initial) => {
        const index = cursor++;
        if (!(index in slots)) slots[index] = initial;
        return [slots[index], (value) => { slots[index] = value; }];
      } };
      if (name.includes("Tooltip")) return { default: "tooltip" };
      return require(name);
    },
  });
  const render = () => {
    cursor = 0;
    const tree = componentModule.exports.default({ connectionId: "fake-account" });
    return { tree, button: tree.props.children };
  };
  const pending = render().button.props.onClick();
  expect(render().button.props["aria-busy"]).toBe(true);
  finish();
  await pending;
  const completed = render();
  expect(completed.tree.props.text).toContain(status === "network" ? "Network failed" : "Provider result");
  expect(completed.button.props.className).toContain(status === "succeeded" ? "text-green-" : "text-red-");
  await completed.button.props.onClick();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(render().button.props.className).toContain("text-text-muted");
  const again = render().button.props.onClick();
  expect(fetch).toHaveBeenCalledTimes(2);
  finish();
  await again;
});
