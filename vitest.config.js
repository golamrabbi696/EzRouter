import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

// Mirror the module aliases declared in jsconfig.json so `vitest run` resolves
// the same bare specifiers Next.js/turbopack resolve at build time:
//   "@/*"     -> ./src/*
//   "open-sse"   -> ./open-sse
//   "open-sse/*" -> ./open-sse/*
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\/(.*)$/, replacement: resolve(root, "src", "$1") },
      { find: /^open-sse\/(.*)$/, replacement: resolve(root, "open-sse", "$1") },
      { find: /^open-sse$/, replacement: resolve(root, "open-sse") },
    ],
  },
  test: {
    include: ["tests/**/*.{test,spec}.{js,ts,tsx}"],
    environment: "node",
    // Real integration tests hit live provider APIs and need credentials/network.
    // They are gated behind RUN_REAL=1 inside the tests themselves; exclude them
    // from the default run so `vitest run` is hermetic.
    exclude: [
      "**/node_modules/**",
      "tests/translator/real/**",
      "tests/e2e/**",
      // Environment-only: missing deps / wrong framework, not code bugs.
      // - embeddings.cloud: imports `/cloud/src/handlers/embeddings.js` (monorepo subpath absent in checkout)
      // - db-benchmark: needs the `lowdb` benchmark dependency (not a correctness test)
      // - kimchi / kimchi-strip-reasoning: written with Node's `node:test`, not Vitest — skip collection under Vitest
      "tests/unit/embeddings.cloud.test.js",
      "tests/unit/db-benchmark.test.js",
      "tests/unit/kimchi.test.js",
      "tests/unit/kimchi-strip-reasoning.test.js",
    ],
  },
});
