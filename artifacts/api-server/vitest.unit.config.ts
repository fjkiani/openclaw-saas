/**
 * Unit-test config for src/lib/**.
 *
 * vitest.config.ts limits `include` to src/routes/__tests__/** ("Only run
 * integration tests in this suite"), so every test file under src/lib/**
 * was unreachable from `pnpm test` -- src/lib/verification/__tests__/
 * rigorGate.test.ts (61 passing tests) had simply stopped being executed.
 *
 * The default suite is deliberately left alone rather than widened:
 * src/lib/legalCounsel/__tests__/counselPhase3.test.ts imports
 * src/lib/legalCorpus/retrieve.ts, which pulls @workspace/db at module load
 * and throws "DATABASE_URL must be set", so broadening `include` would break
 * `pnpm test` for anyone without a provisioned database. Run this suite with
 * `pnpm run test:unit`; it needs DATABASE_URL only for that one file.
 */
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ["src/lib/**/__tests__/**/*.test.ts"],
    },
  }),
);
