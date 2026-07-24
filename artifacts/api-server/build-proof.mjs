// build-proof.mjs — bundle a single proof/fixture entry point with the SAME
// esbuild config the production server uses (build.mjs), so module resolution
// (pg, @workspace/db source, pino via plugin) is identical. Usage:
//   node build-proof.mjs <src-entry.ts> <out.mjs>
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);
const artifactDir = path.dirname(fileURLToPath(import.meta.url));

const [, , entry, outDir] = process.argv;
if (!entry || !outDir) {
  console.error("usage: node build-proof.mjs <src-entry.ts> <out-dir>");
  process.exit(2);
}

await esbuild({
  entryPoints: [path.resolve(artifactDir, entry)],
  platform: "node",
  bundle: true,
  format: "esm",
  outdir: path.resolve(artifactDir, outDir),
  outExtension: { ".js": ".mjs" },
  logLevel: "error",
  external: [
    "*.node", "modal", "sharp", "better-sqlite3", "sqlite3", "canvas", "bcrypt",
    "argon2", "fsevents", "re2", "farmhash", "xxhash-addon", "bufferutil",
    "utf-8-validate", "ssh2", "cpu-features", "dtrace-provider", "isolated-vm",
    "lightningcss", "pg-native", "oracledb", "mongodb-client-encryption",
    "@aws-sdk/*", "@azure/*", "@opentelemetry/*", "@google-cloud/*", "@google/*",
  ],
  plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
  banner: {
    js: `import { createRequire as __cr } from 'node:module';
import __p from 'node:path';
import __u from 'node:url';
globalThis.require = __cr(import.meta.url);
globalThis.__filename = __u.fileURLToPath(import.meta.url);
globalThis.__dirname = __p.dirname(globalThis.__filename);`,
  },
}).catch((err) => { console.error(err); process.exit(1); });
