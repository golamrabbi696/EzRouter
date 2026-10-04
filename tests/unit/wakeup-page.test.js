import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { transform, loadBindings } = require("next/dist/build/swc");
await loadBindings();
const { code } = await transform(readFileSync(new URL("../../src/app/(dashboard)/dashboard/wakeup/page.js", import.meta.url), "utf8"), {
  filename: "page.js",
  jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
  module: { type: "commonjs" },
});

function setup({ enabled = false, taskEnabled = true, running = false } = {}) {
  const task = { id: "task", name: "Morning", provider: "codex", connectionIds: ["account"], model: "", prompt: "hi", reasoning: "none", enabled: taskEnabled, nextRunAt: Date.now(), schedule: { kind: "daily", time: "06:00", timezone: "Asia/Ho_Chi_Minh", days: [0, 1, 2, 3, 4, 5, 6] } };
  const data = { enabled, tasks: [task], accounts: [{ id: "account", provider: "codex", name: "Test account" }], runs: [
    { id: "ping", taskId: null, name: "Ping now", status: "skipped", results: [], trigger: "manual" },
    { id: "run", taskId: "task", name: "Morning run", status: running ? "running" : "succeeded", results: [{ connectionId: "account", status: "succeeded", durationMs: 100, message: "Done" }], trigger: "manual" },
  ] };
  const slots = [data];
  let cursor = 0;
  const fetch = vi.fn(async () => ({ ok: true, json: async () => data }));
  const componentModule = { exports: {} };
  runInNewContext(code, {
    exports: componentModule.exports, module: componentModule, fetch, Intl,
    require: (name) => {
      if (name === "react") return {
        useCallback: (callback) => callback, useEffect: () => {},
        useState: (initial) => {
          const index = cursor++;
          if (!(index in slots)) slots[index] = initial;
          return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
        },
      };
      if (name.startsWith("@/shared/components/")) return { default: name.split("/").at(-1) };
      return require(name);
    },
  });
  function render() {
    cursor = 0;
    const nodes = [];
    const text = [];
    function visit(node) {
      if (Array.isArray(node)) return node.forEach(visit);
      if (typeof node === "string" || typeof node === "number") text.push(String(node));
      if (node?.props) { nodes.push(node); visit(node.props.children); }
    }
    visit(componentModule.exports.default());
    return { nodes, text: text.join(" "), find: (label) => nodes.find((node) => node.props.children === label) };
  }
  return { render, fetch };
}

it("explains global pause and keeps manual runs available", () => {
  const { render } = setup();
  const page = render();
  expect(page.text).toContain("Automatic wakeups paused");
  expect(page.text).toContain("Paused by global setting");
  expect(page.text).toContain("Not scheduled while paused");
  expect(page.find("Run once now").props.disabled).toBe(false);
});

it("distinguishes task pause from global pause and waiting", () => {
  expect(setup({ taskEnabled: false }).render().text).toContain("Task paused");
  expect(setup({ enabled: true }).render().text).toContain("Scheduled");
  expect(setup({ running: true }).render().text).toContain("Running now");
  expect(setup({ running: true }).render().find("Running…").props.disabled).toBe(true);
});

it("separates task history from account pings", () => {
  const { render } = setup();
  render().find("History").props.onClick();
  const page = render();
  expect(page.text).toContain("Morning run");
  expect(page.text).not.toContain("Ping now");
  expect(page.text).toContain("Manual run");
  expect(page.text).toContain("succeeded /");
  expect(page.text).toContain("Times in");
  expect(page.text).toContain("0.1s");
  expect(page.nodes.some((node) => node.type === "p" && node.props.children === "Test account")).toBe(true);
  expect(page.nodes.some((node) => node.type === "p" && node.props.children === "Done")).toBe(true);
});

it("shows schedule summary and global pause warning in editor", () => {
  const { render } = setup();
  render().find("Edit schedule").props.onClick();
  const page = render();
  expect(page.text).toContain("Schedule preview");
  expect(page.text).toContain("Daily at 06:00");
  expect(page.text).toContain("Saving will not resume automatic wakeups.");
  expect(page.find("Advanced settings").type).toBe("summary");
});

it("resumes schedules only through explicit action", async () => {
  const { render, fetch } = setup();
  expect(fetch).not.toHaveBeenCalled();
  await render().find("Resume schedules").props.onClick();
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ action: "enabled", enabled: true });
});

it("separates schedule days, account settings and run result", () => {
  const page = setup({ enabled: true }).render();
  expect(page.find("How it works").type).toBe("summary");
  expect(page.text).toContain("Every day");
  expect(page.nodes.filter((node) => node.type === "li" && node.props["aria-label"]?.endsWith(": scheduled"))).toHaveLength(7);
  expect(page.nodes.some((node) => node.type === "dt" && node.props.children === "Model")).toBe(true);
  expect(page.nodes.some((node) => node.type === "dt" && node.props.children === "Reasoning")).toBe(true);
  expect(page.text).toContain("Running once sends requests immediately and consumes quota.");
});
