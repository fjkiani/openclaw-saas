import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // ESM-native — no transform needed for .ts files when using tsx
    environment: "node",
    globals: false,
    // Run tests sequentially to avoid port conflicts and shared state
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Timeout per test: 15s (model mock calls are instant, but supertest startup adds ~1s)
    testTimeout: 15000,
    hookTimeout: 15000,
    // Only run integration tests in this suite
    include: ["src/routes/__tests__/**/*.test.ts"],
    // Coverage (optional — run with --coverage flag)
    coverage: {
      provider: "v8",
      include: ["src/routes/legal.ts", "src/lib/legalActionEngine.ts"],
      reporter: ["text", "json-summary"],
    },
  },
  resolve: {
    // Map workspace packages to their source files
    alias: {
      "@workspace/db": new URL("../../lib/db/src/index.ts", import.meta.url).pathname,
      "@workspace/crypto-utils": new URL("../../lib/crypto-utils/src/index.ts", import.meta.url).pathname,
      "@workspace/api-zod": new URL("../../lib/api-zod/src/index.ts", import.meta.url).pathname,
      "@workspace/gateway-provisioner": new URL("../../lib/gateway-provisioner/src/index.ts", import.meta.url).pathname,
      "@workspace/skill-contract": new URL("../../lib/skill-contract/src/index.ts", import.meta.url).pathname,
    },
  },
});
