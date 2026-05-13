/**
 * seed-demo.ts
 *
 * Idempotent demo seed for OpenClaw SaaS.
 * Run after `pnpm --filter @workspace/db run push`:
 *
 *   DATABASE_URL=<url> pnpm --filter @workspace/scripts tsx src/seed-demo.ts
 *
 * What it does:
 *   1. Upserts the 6 ZOA skills (slug-keyed, safe to re-run)
 *   2. Creates a demo tenant owned by DEMO_USER_ID (env var or fallback)
 *   3. Installs all 6 ZOA skills on that tenant
 *   4. Inserts CERTIFIED benchmark records for 3 skills, CONDITIONAL for 2, FAILED for 1
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

// ── 2. Benchmark fixtures (keyed by skill slug) ───────────────────────────────

const BENCHMARK_FIXTURES: Record<string, {
  grade: string;
  overallScore: number;
  levelScores: Record<string, unknown>;
}> = {
  "zoa-billing-agent": {
    grade: "CERTIFIED",
    overallScore: 91,
    levelScores: {
      l1: { score: 95, passed: 19, total: 20, weight: 0.25 },
      l2: { score: 88, passed: 22, total: 25, weight: 0.25 },
      l3: { score: 90, passed: 18, total: 20, weight: 0.25 },
      l4: { score: 91, passed: 9,  total: 10, weight: 0.25 },
    },
  },
  "zoa-scheduling-agent": {
    grade: "CERTIFIED",
    overallScore: 87,
    levelScores: {
      l1: { score: 92, passed: 18, total: 20, weight: 0.25 },
      l2: { score: 84, passed: 21, total: 25, weight: 0.25 },
      l3: { score: 85, passed: 17, total: 20, weight: 0.25 },
      l4: { score: 87, passed: 9,  total: 10, weight: 0.25 },
    },
  },
  "zoa-payroll-agent": {
    grade: "CERTIFIED",
    overallScore: 83,
    levelScores: {
      l1: { score: 90, passed: 18, total: 20, weight: 0.25 },
      l2: { score: 80, passed: 20, total: 25, weight: 0.25 },
      l3: { score: 82, passed: 16, total: 20, weight: 0.25 },
      l4: { score: 80, passed: 8,  total: 10, weight: 0.25 },
    },
  },
  "zoa-hr-agent": {
    grade: "CONDITIONAL",
    overallScore: 71,
    levelScores: {
      l1: { score: 85, passed: 17, total: 20, weight: 0.25 },
      l2: { score: 72, passed: 18, total: 25, weight: 0.25 },
      l3: { score: 65, passed: 13, total: 20, weight: 0.25 },
      l4: { score: 62, passed: 6,  total: 10, weight: 0.25 },
    },
  },
  "zoa-procurement-agent": {
    grade: "CONDITIONAL",
    overallScore: 68,
    levelScores: {
      l1: { score: 80, passed: 16, total: 20, weight: 0.25 },
      l2: { score: 70, passed: 17, total: 25, weight: 0.25 },
      l3: { score: 62, passed: 12, total: 20, weight: 0.25 },
      l4: { score: 60, passed: 6,  total: 10, weight: 0.25 },
    },
  },
  "zoa-compliance-agent": {
    grade: "FAILED",
    overallScore: 44,
    levelScores: {
      l1: { score: 70, passed: 14, total: 20, weight: 0.25 },
      l2: { score: 48, passed: 12, total: 25, weight: 0.25 },
      l3: { score: 30, passed: 6,  total: 20, weight: 0.25 },
      l4: { score: 28, passed: 3,  total: 10, weight: 0.25 },
    },
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

  // ── Step 2: Upsert benchmark records ──────────────────────────────────────
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
    console.log(`  OK  ${slug} → grade=${fixture.grade} score=${fixture.overallScore}`);
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
  console.log(`  Benchmarks: 3 CERTIFIED, 2 CONDITIONAL, 1 FAILED\n`);

  process.exit(0);
}

main().catch((err) => {
  console.error("\nSeed failed:", err);
  process.exit(1);
});
