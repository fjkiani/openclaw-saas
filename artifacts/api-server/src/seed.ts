/**
 * seed.ts — Idempotent demo seed. Runs on every server startup.
 * Safe to run multiple times (ON CONFLICT DO NOTHING / DO UPDATE).
 */
import { pool } from "@workspace/db";
import { logger } from "./lib/logger";

const DEMO_USER_ID = process.env.DEMO_USER_ID || "user_3DhVktxcTmcEqDWgYpMihDOy00t";

const ZOA_SKILLS = [
  { slug: "zoa-billing",     name: "ZOA Billing Agent",     category: "Finance",    description: "Automates invoice processing, payment reconciliation, and billing dispute resolution.", featured: true,  l4: 9.1, l3: 88, l2: 72, l1: 91, grade: "CERTIFIED" },
  { slug: "zoa-scheduling",  name: "ZOA Scheduling Agent",  category: "Operations", description: "Manages calendar coordination, meeting scheduling, and resource allocation.", featured: true,  l4: 8.7, l3: 85, l2: 68, l1: 89, grade: "CERTIFIED" },
  { slug: "zoa-payroll",     name: "ZOA Payroll Agent",     category: "HR",         description: "Handles payroll calculations, tax withholding, direct deposit, and compliance reporting.", featured: true,  l4: 8.0, l3: 82, l2: 65, l1: 87, grade: "CERTIFIED" },
  { slug: "zoa-hr",          name: "ZOA HR Agent",          category: "HR",         description: "Automates onboarding, offboarding, PTO tracking, and employee record management.", featured: false, l4: 6.2, l3: 75, l2: 55, l1: 78, grade: "CONDITIONAL" },
  { slug: "zoa-procurement", name: "ZOA Procurement Agent", category: "Operations", description: "Manages purchase orders, vendor negotiations, and supply chain coordination.", featured: false, l4: 6.0, l3: 72, l2: 52, l1: 74, grade: "CONDITIONAL" },
  { slug: "zoa-compliance",  name: "ZOA Compliance Agent",  category: "Legal",      description: "Monitors regulatory requirements, generates compliance reports, and flags policy violations.", featured: false, l4: 2.8, l3: 45, l2: 38, l1: 52, grade: "FAILED" },
];

export async function runSeed(): Promise<void> {
  const client = await pool.connect();
  try {
    const skillIds: Record<string, number> = {};

    for (const s of ZOA_SKILLS) {
      const res = await client.query(`
        INSERT INTO skills (name, slug, description, category, featured, tags, source)
        VALUES ($1,$2,$3,$4,$5,$6,'manual')
        ON CONFLICT (slug) DO UPDATE SET
          name=EXCLUDED.name, description=EXCLUDED.description,
          category=EXCLUDED.category, featured=EXCLUDED.featured
        RETURNING id
      `, [s.name, s.slug, s.description, s.category, s.featured,
          ["zoa", "multi-agent", s.category.toLowerCase()]]);
      skillIds[s.slug] = res.rows[0].id;
    }

    for (const s of ZOA_SKILLS) {
      await client.query(`
        INSERT INTO skill_benchmarks (skill_id, benchmark_id, status, overall_score, level_scores, grade, result_json)
        VALUES ($1,$2,'completed',$3,$4,$5,$6)
        ON CONFLICT DO NOTHING
      `, [
        skillIds[s.slug],
        `demo-${s.slug}`,
        s.l4,
        JSON.stringify({ l1: s.l1, l2: s.l2, l3: s.l3, l4: s.l4 }),
        s.grade,
        JSON.stringify({ grade: s.grade, levelScores: { l1: s.l1, l2: s.l2, l3: s.l3, l4: s.l4 } }),
      ]);
    }

    const tenantId = "tenant-demo-openclaw";
    await client.query(`
      INSERT INTO tenants (id, name, user_id, plan)
      VALUES ($1,'Demo Workspace',$2,'free')
      ON CONFLICT (id) DO UPDATE SET user_id=EXCLUDED.user_id, name=EXCLUDED.name
    `, [tenantId, DEMO_USER_ID]);

    for (const s of ZOA_SKILLS) {
      await client.query(`
        INSERT INTO tenant_skills (tenant_id, skill_id, enabled)
        VALUES ($1,$2,true) ON CONFLICT DO NOTHING
      `, [tenantId, skillIds[s.slug]]);
    }

    logger.info({ userId: DEMO_USER_ID, tenantId, skills: ZOA_SKILLS.length }, "Seed complete");
  } finally {
    client.release();
  }
}
