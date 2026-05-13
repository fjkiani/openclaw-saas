/**
 * seed-demo.ts
 *
 * Idempotent demo seed for OpenClaw SaaS.
 * Run after `pnpm --filter @workspace/db run push`:
 *
 *   DATABASE_URL=<url> pnpm --filter @workspace/scripts run seed-demo
 *
 * What it does:
 *   1. Upserts the 6 ZOA skills (slug-keyed, safe to re-run)
 *   2. Inserts benchmark records for all 6 skills
 *      (3 CERTIFIED / 2 CONDITIONAL / 1 FAILED)
 *   3. Creates a demo tenant owned by DEMO_USER_ID (env var or fallback)
 *   4. Installs all 6 ZOA skills on that tenant
 *
 * Score scales (IMPORTANT — must match permission_gate.py thresholds):
 *   l4: 0.0–10.0  gate threshold: l4 >= 6.0 to execute
 *   l2: 0–100     gate threshold: l2 >= 60 for write tools
 *   l3: 0–100     gate threshold: l3 >= 80 for aggressive chaining
 *   l1: 0–100     informational only
 *
 * BenchmarkExplainer renders levelScores values directly as numbers,
 * so the stored shape must be { l1: number, l2: number, l3: number, l4: number }
 * with the correct scale per level.
 *
 * The demo tenant userId must match the Clerk userId of the account you log in with.
 * Set DEMO_USER_ID env var to your Clerk userId (found in Clerk dashboard → Users).
 * If not set, defaults to "user_demo_placeholder" — update after first login.
 */

import { db, skillsTable, tenantsTable, tenantSkillsTable, skillBenchmarksTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import crypto from "crypto";

const DEMO_USER_ID = process.env.DEMO_USER_ID ?? "user_demo_placeholder";

// ── 1. ZOA Skills ─────────────────────────────────────────────────────────────

const ZOA_SKILLS = [
  {
    name: "ZOA Billing Agent",
    slug: "zoa-billing-agent",
    description:
      "Invoice Reaver — processes invoices via multimodal OCR (Gemma 4 26B), auto-generates payment follow-ups, detects fraud via pattern analysis, and generates structured invoice JSON from contracts.",
    category: "Finance",
    featured: true,
    stars: 4812,
    installs: 18400,
    tags: ["zoa", "billing", "ocr", "fraud-detection", "invoicing"],
  },
  {
    name: "ZOA Scheduling Agent",
    slug: "zoa-scheduling-agent",
    description:
      "Time Optimizer — finds optimal meeting slots by analyzing participant availability and ROI of time, books meetings with auto-generated agendas, handles declines intelligently.",
    category: "Productivity",
    featured: true,
    stars: 3901,
    installs: 14200,
    tags: ["zoa", "scheduling", "calendar", "meetings"],
  },
  {
    name: "ZOA Payroll Agent",
    slug: "zoa-payroll-agent",
    description:
      "Wage Calculator — computes gross/net pay with deductions, detects performance anomalies from productivity metrics, manages commission holds triggered by billing events.",
    category: "HR & Payroll",
    featured: true,
    stars: 3210,
    installs: 11800,
    tags: ["zoa", "payroll", "compensation", "anomaly-detection"],
  },
  {
    name: "ZOA HR Agent",
    slug: "zoa-hr-agent",
    description:
      "People Ops — screens resumes against structured requirements, conducts AI-assisted performance reviews, manages onboarding checklists and offboarding workflows.",
    category: "HR & Payroll",
    featured: true,
    stars: 2890,
    installs: 9400,
    tags: ["zoa", "hr", "recruiting", "performance", "offboarding"],
  },
  {
    name: "ZOA Procurement Agent",
    slug: "zoa-procurement-agent",
    description:
      "Supply Optimizer — scans receipts and invoices via OCR, generates game-theory-based supplier negotiation strategies, monitors inventory against thresholds and triggers auto-orders.",
    category: "Operations",
    featured: true,
    stars: 2540,
    installs: 8100,
    tags: ["zoa", "procurement", "inventory", "negotiation", "supply-chain"],
  },
  {
    name: "ZOA Compliance Agent",
    slug: "zoa-compliance-agent",
    description:
      "Regulation Navigator — interprets regulatory text to extract actionable requirements, generates audit-ready documentation, assesses operational risk by jurisdiction.",
    category: "Legal & Compliance",
    featured: true,
    stars: 2100,
    installs: 6700,
    tags: ["zoa", "compliance", "audit", "risk", "regulation"],
  },
];

// ── 2. Benchmark fixtures ─────────────────────────────────────────────────────
//
// Score scales:
//   l4: 0.0–10.0  (permission gate: l4 >= 6.0 → certified)
//   l2: 0–100     (permission gate: l2 >= 60 → write tools allowed)
//   l3: 0–100     (permission gate: l3 >= 80 → aggressive chaining)
//   l1: 0–100     (informational)
//
// These are stored as-is in levelScores jsonb and read directly by:
//   - BenchmarkExplainer: renders each value as a number
//   - KairosTab resolvedScores: passes l4/l2/l3 directly to POST /kairos/run
//   - permission_gate.py: compares against thresholds above

const BENCHMARK_FIXTURES: Record<string, {
  grade: string;
  overallScore: number;
  levelScores: { l1: number; l2: number; l3: number; l4: number };
}> = {
  // CERTIFIED: l4 >= 6.0, l2 >= 60, l3 >= 80
  "zoa-billing-agent": {
    grade: "CERTIFIED",
    overallScore: 91,
    levelScores: { l1: 95, l2: 88, l3: 90, l4: 9.1 },
  },
  "zoa-scheduling-agent": {
    grade: "CERTIFIED",
    overallScore: 87,
    levelScores: { l1: 92, l2: 84, l3: 85, l4: 8.7 },
  },
  "zoa-payroll-agent": {
    grade: "CERTIFIED",
    overallScore: 83,
    levelScores: { l1: 90, l2: 80, l3: 82, l4: 8.0 },
  },
  // CONDITIONAL: l4 >= 6.0 (can execute) but l2 < 60 or l3 < 80 (restricted)
  "zoa-hr-agent": {
    grade: "CONDITIONAL",
    overallScore: 71,
    levelScores: { l1: 85, l2: 55, l3: 65, l4: 6.2 },
  },
  "zoa-procurement-agent": {
    grade: "CONDITIONAL",
    overallScore: 68,
    levelScores: { l1: 80, l2: 52, l3: 62, l4: 6.0 },
  },
  // FAILED: l4 < 6.0 → all tools blocked
  "zoa-compliance-agent": {
    grade: "FAILED",
    overallScore: 44,
    levelScores: { l1: 70, l2: 48, l3: 30, l4: 2.8 },
  },
};

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== OpenClaw Demo Seed ===\n");
  console.log(`Demo user ID: ${DEMO_USER_ID}`);
  if (DEMO_USER_ID === "user_demo_placeholder") {
    console.warn(
      "\n  WARNING: DEMO_USER_ID not set. Tenant will be owned by 'user_demo_placeholder'.\n" +
      "  Set DEMO_USER_ID=<your-clerk-user-id> to own the tenant with your login.\n"
    );
  }

  // ── Step 1: Upsert skills ──────────────────────────────────────────────────
  console.log("\n[1/4] Upserting ZOA skills...");
  const skillIds: Record<string, number> = {};

  for (const skill of ZOA_SKILLS) {
    const [row] = await db
      .insert(skillsTable)
      .values(skill)
      .onConflictDoUpdate({
        target: skillsTable.slug,
        set: {
          name: skill.name,
          description: skill.description,
          category: skill.category,
          featured: skill.featured,
          stars: skill.stars,
          installs: skill.installs,
          tags: skill.tags,
        },
      })
      .returning();
    skillIds[skill.slug] = row.id;
    console.log(`  OK  ${skill.slug} → id=${row.id}`);
  }

  // ── Step 2: Insert benchmark records ──────────────────────────────────────
  console.log("\n[2/4] Inserting benchmark records...");
  for (const [slug, fixture] of Object.entries(BENCHMARK_FIXTURES)) {
    const skillId = skillIds[slug];
    if (!skillId) continue;
    const benchmarkId = `demo-${slug}-${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(skillBenchmarksTable).values({
      skillId,
      benchmarkId,
      grade: fixture.grade,
      overallScore: fixture.overallScore,
      levelScores: fixture.levelScores,
      llmResults: {},
      testSuite: "standard",
      durationMs: Math.floor(Math.random() * 8000) + 4000,
    });
    console.log(
      `  OK  ${slug} → grade=${fixture.grade} overall=${fixture.overallScore} ` +
      `l4=${fixture.levelScores.l4} l2=${fixture.levelScores.l2} l3=${fixture.levelScores.l3}`
    );
  }

  // ── Step 3: Create demo tenant (skip if already exists for this user) ──────
  console.log("\n[3/4] Creating demo tenant...");
  const existing = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.userId, DEMO_USER_ID));

  let tenantId: number;
  if (existing.length > 0) {
    tenantId = existing[0].id;
    console.log(`  SKIP  Tenant already exists for user (id=${tenantId})`);
  } else {
    const gatewayToken = `tok_demo_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const [tenant] = await db
      .insert(tenantsTable)
      .values({
        userId: DEMO_USER_ID,
        name: "Demo Workspace",
        description: "Pre-seeded demo workspace with all ZOA agents installed",
        status: "stopped",
        skillPack: "zoa-full",
        agentCount: 6,
        gatewayToken,
      })
      .returning();
    tenantId = tenant.id;
    console.log(`  OK  Created tenant id=${tenantId} name="Demo Workspace"`);
  }

  // ── Step 4: Install all skills on tenant (skip existing) ──────────────────
  console.log("\n[4/4] Installing skills on demo tenant...");
  const installedSkills = await db
    .select()
    .from(tenantSkillsTable)
    .where(eq(tenantSkillsTable.tenantId, tenantId));
  const installedIds = new Set(installedSkills.map((r) => r.skillId));

  for (const [slug, skillId] of Object.entries(skillIds)) {
    if (installedIds.has(skillId)) {
      console.log(`  SKIP  ${slug} already installed`);
      continue;
    }
    await db.insert(tenantSkillsTable).values({ tenantId, skillId });
    console.log(`  OK  Installed ${slug} on tenant ${tenantId}`);
  }

  console.log("\n=== Seed complete ===");
  console.log(`\nDemo workspace ready:`);
  console.log(`  Tenant id : ${tenantId}`);
  console.log(`  User id   : ${DEMO_USER_ID}`);
  console.log(`  Skills    : ${Object.keys(skillIds).length} installed`);
  console.log(`\nPermission gate preview:`);
  for (const [slug, f] of Object.entries(BENCHMARK_FIXTURES)) {
    const l4ok = f.levelScores.l4 >= 6.0;
    const l2ok = f.levelScores.l2 >= 60;
    const l3ok = f.levelScores.l3 >= 80;
    const exec = l4ok ? (l2ok ? "WRITE+READ" : "READ-ONLY") : "BLOCKED";
    console.log(`  ${exec.padEnd(10)} ${slug}  l4=${f.levelScores.l4} l2=${f.levelScores.l2} l3=${f.levelScores.l3}`);
  }
  console.log("");

  process.exit(0);
}

main().catch((err) => {
  console.error("\nSeed failed:", err);
  process.exit(1);
});
