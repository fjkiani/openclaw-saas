/**
 * seed-standalone.mjs — Standalone seed using raw pg (no workspace deps).
 * Run: DATABASE_URL=... DEMO_USER_ID=... node scripts/seed-standalone.mjs
 */
import pg from "pg";
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const DEMO_USER_ID = process.env.DEMO_USER_ID || "user_demo_placeholder";

if (!DATABASE_URL) { console.error("DATABASE_URL required"); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL });

const ZOA_SKILLS = [
  { slug: "zoa-billing",      name: "ZOA Billing Agent",      category: "Finance",    description: "Automates invoice processing, payment reconciliation, and billing dispute resolution using multi-agent orchestration.", featured: true,  l4: 9.1, l3: 88, l2: 72, l1: 91, grade: "CERTIFIED" },
  { slug: "zoa-scheduling",   name: "ZOA Scheduling Agent",   category: "Operations", description: "Manages calendar coordination, meeting scheduling, and resource allocation across enterprise systems.", featured: true,  l4: 8.7, l3: 85, l2: 68, l1: 89, grade: "CERTIFIED" },
  { slug: "zoa-payroll",      name: "ZOA Payroll Agent",      category: "HR",         description: "Handles payroll calculations, tax withholding, direct deposit, and compliance reporting.", featured: true,  l4: 8.0, l3: 82, l2: 65, l1: 87, grade: "CERTIFIED" },
  { slug: "zoa-hr",           name: "ZOA HR Agent",           category: "HR",         description: "Automates onboarding, offboarding, PTO tracking, and employee record management.", featured: false, l4: 6.2, l3: 75, l2: 55, l1: 78, grade: "CONDITIONAL" },
  { slug: "zoa-procurement",  name: "ZOA Procurement Agent",  category: "Operations", description: "Manages purchase orders, vendor negotiations, and supply chain coordination.", featured: false, l4: 6.0, l3: 72, l2: 52, l1: 74, grade: "CONDITIONAL" },
  { slug: "zoa-compliance",   name: "ZOA Compliance Agent",   category: "Legal",      description: "Monitors regulatory requirements, generates compliance reports, and flags policy violations.", featured: false, l4: 2.8, l3: 45, l2: 38, l1: 52, grade: "FAILED" },
];

async function seed() {
  const client = await pool.connect();
  try {
    console.log("Connected to DB:", DATABASE_URL.split("@")[1]?.split("/")[0]);

    // Upsert skills
    console.log("\nUpserting ZOA skills...");
    const skillIds = {};
    for (const s of ZOA_SKILLS) {
      const res = await client.query(`
        INSERT INTO skills (name, slug, description, category, featured, tags, source)
        VALUES ($1, $2, $3, $4, $5, $6, 'manual')
        ON CONFLICT (slug) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          category = EXCLUDED.category,
          featured = EXCLUDED.featured
        RETURNING id
      `, [s.name, s.slug, s.description, s.category, s.featured, ["zoa", "multi-agent", s.category.toLowerCase()]]);
      skillIds[s.slug] = res.rows[0].id;
      console.log(`  ✓ ${s.name} (id=${res.rows[0].id})`);
    }

    // Upsert benchmark records
    console.log("\nUpserting benchmark records...");
    for (const s of ZOA_SKILLS) {
      const skillId = skillIds[s.slug];
      const levelScores = { l1: s.l1, l2: s.l2, l3: s.l3, l4: s.l4 };
      const overallScore = s.l4;
      await client.query(`
        INSERT INTO skill_benchmarks (skill_id, benchmark_id, status, overall_score, level_scores, grade, result_json)
        VALUES ($1, $2, 'completed', $3, $4, $5, $6)
        ON CONFLICT DO NOTHING
      `, [
        skillId,
        `demo-${s.slug}`,
        overallScore,
        JSON.stringify(levelScores),
        s.grade,
        JSON.stringify({ summary: `Demo benchmark for ${s.name}`, levelScores, grade: s.grade })
      ]);
      console.log(`  ✓ ${s.slug}: ${s.grade} (L4=${s.l4})`);
    }

    // Upsert demo tenant
    console.log("\nUpserting demo tenant...");
    const tenantId = "tenant-demo-openclaw";
    await client.query(`
      INSERT INTO tenants (id, name, user_id, plan)
      VALUES ($1, 'Demo Workspace', $2, 'free')
      ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, name = EXCLUDED.name
    `, [tenantId, DEMO_USER_ID]);
    console.log(`  ✓ Tenant: ${tenantId} → user ${DEMO_USER_ID}`);

    // Install all skills on demo tenant
    console.log("\nInstalling skills on demo tenant...");
    for (const s of ZOA_SKILLS) {
      const skillId = skillIds[s.slug];
      await client.query(`
        INSERT INTO tenant_skills (tenant_id, skill_id, enabled)
        VALUES ($1, $2, true)
        ON CONFLICT DO NOTHING
      `, [tenantId, skillId]);
      console.log(`  ✓ Installed ${s.slug}`);
    }

    // Verify
    const { rows: [{ count }] } = await client.query(`SELECT count(*)::int FROM skills`);
    const { rows: [{ tcount }] } = await client.query(`SELECT count(*)::int AS tcount FROM tenants`);
    const { rows: [{ bcount }] } = await client.query(`SELECT count(*)::int AS bcount FROM skill_benchmarks`);
    console.log(`\n✅ Seed complete: ${count} skills, ${tcount} tenants, ${bcount} benchmarks`);

  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(e => { console.error("Seed failed:", e.message); process.exit(1); });
