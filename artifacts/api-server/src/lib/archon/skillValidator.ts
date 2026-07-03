import { execSync } from "child_process";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { GeneratedSkill } from "./skillGenerator";

export interface L0Result {
  l0_pass: boolean;
  error?: string;
  checks: {
    has_name_export: boolean;
    has_description_export: boolean;
    has_run_export: boolean;
    has_input_schema: boolean;
    has_output_schema: boolean;
    typescript_valid: boolean;
  };
}

export function validateSkill(skill: GeneratedSkill): L0Result {
  const impl = skill.implementation ?? "";
  const checks = {
    has_name_export: /export\s+const\s+name\s*[=:]/.test(impl) || /export\s*\{[^}]*\bname\b/.test(impl),
    has_description_export: /export\s+const\s+description\s*[=:]/.test(impl) || /export\s*\{[^}]*\bdescription\b/.test(impl),
    has_run_export: /export\s+(async\s+)?function\s+run\b/.test(impl) || /export\s+const\s+run\s*=/.test(impl),
    has_input_schema: /export\s+const\s+inputSchema/.test(impl) || impl.includes("inputSchema"),
    has_output_schema: /export\s+const\s+outputSchema/.test(impl) || impl.includes("outputSchema"),
    typescript_valid: false,
  };

  const structuralPass = checks.has_name_export && checks.has_description_export &&
    checks.has_run_export && checks.has_input_schema && checks.has_output_schema;

  if (!structuralPass) {
    const missing = Object.entries(checks)
      .filter(([k, v]) => k !== "typescript_valid" && !v)
      .map(([k]) => k.replace("has_", "").replace(/_/g, " "));
    return { l0_pass: false, error: `Missing required exports: ${missing.join(", ")}`, checks };
  }

  const tmpDir = join(tmpdir(), `skill-validate-${randomUUID()}`);
  const tmpFile = join(tmpDir, "skill.ts");
  const tsconfigFile = join(tmpDir, "tsconfig.json");

  try {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(tmpFile, impl, "utf8");
    writeFileSync(tsconfigFile, JSON.stringify({
      compilerOptions: { target: "ES2022", module: "commonjs", strict: false, skipLibCheck: true, noEmit: true },
      include: ["skill.ts"],
    }), "utf8");

    execSync(`npx tsc --project ${tsconfigFile}`, { cwd: tmpDir, timeout: 15000, stdio: "pipe" });
    checks.typescript_valid = true;
    return { l0_pass: true, checks };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const tscErrors = errorMsg.split("\n")
      .filter((l) => l.includes("error TS") || l.includes("skill.ts"))
      .slice(0, 5).join("\n");
    return {
      l0_pass: false,
      error: `TypeScript compilation failed:\n${tscErrors || errorMsg.slice(0, 500)}`,
      checks,
    };
  } finally {
    try { unlinkSync(tmpFile); unlinkSync(tsconfigFile); } catch {}
  }
}
