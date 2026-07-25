import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);
const dir = path.dirname(fileURLToPath(import.meta.url));
const entry = process.argv[2] || "bench/rigor/runBench.mts";
const outdir = process.argv[3] || "/workspace/benchbundle";

await esbuild({
  entryPoints: [path.join(dir, entry)],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outdir,
  external: ["pg", "pg-native"],
  plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
  logLevel: "info",
});
console.log("bundled -> ", outdir);
