/**
 * Seed script: inserts the 6 ZOA agent skills into the OpenClaw skill catalog.
 * Run with: npx tsx scripts/seed-zoa-skills.ts
 */

import { db, skillsTable } from "@workspace/db";

const ZOA_SKILLS = [
  {
    name: "ZOA Billing Agent",
    slug: "zoa-billing-agent",
    description:
      "Invoice Reaver — processes invoices via multimodal OCR (Gemma 4 26B), auto-generates payment follow-ups, detects fraud via pattern analysis, and generates structured invoice JSON from contracts. Publishes billing events to the ZOA context bus.",
    category: "Finance",
    featured: true,
    stars: 0,
    installs: 0,
    tags: ["zoa", "billing", "ocr", "fraud-detection", "invoicing", "gemma-4-26b"],
  },
  {
    name: "ZOA Scheduling Agent",
    slug: "zoa-scheduling-agent",
    description:
      "Time Optimizer — finds optimal meeting slots by analyzing participant availability and ROI of time, books meetings with auto-generated agendas, handles declines intelligently, and blocks slots on compliance alerts. Powered by Hermes 3 405B.",
    category: "Productivity",
    featured: true,
    stars: 0,
    installs: 0,
    tags: ["zoa", "scheduling", "calendar", "meetings", "hermes-3-405b"],
  },
  {
    name: "ZOA Payroll Agent",
    slug: "zoa-payroll-agent",
    description:
      "Wage Calculator — computes gross/net pay with deductions, detects performance anomalies from productivity metrics, manages commission holds triggered by billing events, and recommends compensation adjustments. Powered by Qwen3 Coder 480B for precise computation.",
    category: "HR & Payroll",
    featured: true,
    stars: 0,
    installs: 0,
    tags: ["zoa", "payroll", "compensation", "anomaly-detection", "qwen3-coder"],
  },
  {
    name: "ZOA HR Agent",
    slug: "zoa-hr-agent",
    description:
      "Talent Optimizer — screens resumes against role requirements, conducts structured performance reviews, generates exit documentation and offboarding checklists, and flags performance issues to the ZOA context bus. Powered by Hermes 3 405B.",
    category: "HR & Payroll",
    featured: true,
    stars: 0,
    installs: 0,
    tags: ["zoa", "hr", "recruiting", "performance", "offboarding", "hermes-3-405b"],
  },
  {
    name: "ZOA Procurement Agent",
    slug: "zoa-procurement-agent",
    description:
      "Supply Optimizer — scans receipts and invoices via OCR, generates game-theory-based supplier negotiation strategies, monitors inventory against thresholds and triggers auto-orders. Powered by Baidu OCR (fast) + Hermes 3 405B (negotiation).",
    category: "Operations",
    featured: true,
    stars: 0,
    installs: 0,
    tags: ["zoa", "procurement", "inventory", "negotiation", "ocr", "supply-chain"],
  },
  {
    name: "ZOA Compliance Agent",
    slug: "zoa-compliance-agent",
    description:
      "Regulation Navigator — interprets regulatory text to extract actionable requirements, generates audit-ready documentation, assesses operational risk by jurisdiction, and responds to fraud/compliance alerts from the ZOA context bus. Powered by Arcee Trinity (deep thinking).",
    category: "Legal & Compliance",
    featured: true,
    stars: 0,
    installs: 0,
    tags: ["zoa", "compliance", "audit", "risk", "regulation", "arcee-trinity"],
  },
];

async function main() {
  console.log("Seeding ZOA skills into OpenClaw catalog...");

  for (const skill of ZOA_SKILLS) {
    try {
      const [inserted] = await db
        .insert(skillsTable)
        .values(skill)
        .onConflictDoUpdate({
          target: skillsTable.slug,
          set: {
            name: skill.name,
            description: skill.description,
            category: skill.category,
            featured: skill.featured,
            tags: skill.tags,
          },
        })
        .returning();
      console.log(`  OK ${inserted.name} (id: ${inserted.id})`);
    } catch (err) {
      console.error(`  FAILED ${skill.name}:`, err);
    }
  }

  console.log("Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
