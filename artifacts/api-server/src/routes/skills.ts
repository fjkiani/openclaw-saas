import { Router, type IRouter, type Request, type Response } from "express";
import { eq, ilike, or, sql } from "drizzle-orm";
import { db, skillsTable, skillBenchmarksTable } from "@workspace/db";
import {
  ListSkillsQueryParams,
  ListSkillsResponse,
  ListFeaturedSkillsResponse,
  ListSkillCategoriesResponse,
} from "@workspace/api-zod";
import { runBenchmark, getBenchmarkResult } from "../lib/benchmarkClient";

const SKILLS_SOURCE =
  "https://raw.githubusercontent.com/VoltAgent/awesome-openclaw-skills/main/README.md";

const SKILLS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PER_CATEGORY = 40;

let lastFetchedAt: Date | null = null;
let fetchInProgress = false;

interface ParsedSkill {
  name: string;
  slug: string;
  description: string;
  category: string;
  featured: boolean;
  stars: number;
  installs: number;
  tags: string[];
}

function parseReadme(markdown: string): ParsedSkill[] {
  const skills: ParsedSkill[] = [];
  let currentCategory = "";
  let categoryIndex = 0;

  const lines = markdown.split("\n");
  const categoryPattern =
    /<summary><h3[^>]*>([^<]+)<\/h3><\/summary>/;
  const skillPattern = /^-\s+\[([^\]]+)\]\(https?:\/\/[^\)]+\/skills\/([^\)]+)\)\s*-?\s*(.*)/;

  const countPerCategory: Record<string, number> = {};

  for (const line of lines) {
    const catMatch = line.match(categoryPattern);
    if (catMatch) {
      currentCategory = catMatch[1].trim();
      categoryIndex++;
      continue;
    }

    if (!currentCategory) continue;

    const count = countPerCategory[currentCategory] ?? 0;
    if (count >= MAX_PER_CATEGORY) continue;

    const skillMatch = line.match(skillPattern);
    if (skillMatch) {
      const [, rawName, slug, rawDesc] = skillMatch;
      const name = rawName.trim();
      const description = rawDesc.trim().replace(/\.$/, "") || name;

      skills.push({
        name,
        slug,
        description: description.slice(0, 512),
        category: currentCategory,
        featured: count < 3,
        stars: Math.floor(Math.random() * 500) + 10,
        installs: Math.floor(Math.random() * 2000) + 50,
        tags: [currentCategory.toLowerCase().replace(/[^a-z0-9]+/g, "-")],
      });

      countPerCategory[currentCategory] = count + 1;
    }
  }

  return skills;
}

async function refreshSkillsFromGitHub(): Promise<void> {
  if (fetchInProgress) return;
  fetchInProgress = true;

  try {
    const res = await fetch(SKILLS_SOURCE, {
      headers: { "User-Agent": "OpenClaw-SaaS/1.0" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new Error(`GitHub fetch failed: ${res.status}`);
    }

    const markdown = await res.text();
    const parsed = parseReadme(markdown);

    if (parsed.length === 0) {
      throw new Error("README parsed 0 skills — skipping update");
    }

    // Use upsert (ON CONFLICT slug DO UPDATE) instead of DELETE + INSERT
    // This preserves benchmark data for seeded ZOA skills and avoids FK violations.
    for (let i = 0; i < parsed.length; i += 100) {
      const chunk = parsed.slice(i, i + 100);
      await db
        .insert(skillsTable)
        .values(chunk)
        .onConflictDoUpdate({
          target: skillsTable.slug,
          set: {
            name: sql`EXCLUDED.name`,
            description: sql`EXCLUDED.description`,
            category: sql`EXCLUDED.category`,
            featured: sql`EXCLUDED.featured`,
            tags: sql`EXCLUDED.tags`,
          },
        });
    }

    lastFetchedAt = new Date();
  } finally {
    fetchInProgress = false;
  }
}

async function ensureSkillsLoaded(): Promise<void> {
  // If we already fetched this process lifetime and it's fresh, skip.
  if (lastFetchedAt && Date.now() - lastFetchedAt.getTime() < SKILLS_TTL_MS) {
    return;
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(skillsTable);

  if (count === 0) {
    // DB is empty — fetch from GitHub now.
    await refreshSkillsFromGitHub();
    return;
  }

  if (!lastFetchedAt) {
    // DB has rows (seeded on startup) but this process hasn't fetched yet.
    // Mark as "loaded" so we don't wipe seed data on first request.
    lastFetchedAt = new Date();
    // Kick off a background refresh so GitHub skills get merged in.
    refreshSkillsFromGitHub().catch(() => {});
    return;
  }

  if (Date.now() - lastFetchedAt.getTime() >= SKILLS_TTL_MS) {
    refreshSkillsFromGitHub().catch(() => {});
  }
}

const router: IRouter = Router();

router.get("/skills", async (req, res): Promise<void> => {
  await ensureSkillsLoaded();

  const query = ListSkillsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  let dbQuery = db.select().from(skillsTable).$dynamic();

  const conditions = [];
  if (query.data.category) {
    conditions.push(eq(skillsTable.category, query.data.category));
  }
  if (query.data.search) {
    conditions.push(
      or(
        ilike(skillsTable.name, `%${query.data.search}%`),
        ilike(skillsTable.description, `%${query.data.search}%`),
      ),
    );
  }

  if (conditions.length > 0) {
    const { and } = await import("drizzle-orm");
    dbQuery = dbQuery.where(and(...conditions));
  }

  const skills = await dbQuery;
  res.json(ListSkillsResponse.parse(skills));
});

router.get("/skills/featured", async (_req, res): Promise<void> => {
  await ensureSkillsLoaded();

  const skills = await db
    .select()
    .from(skillsTable)
    .where(eq(skillsTable.featured, true))
    .limit(12);
  res.json(ListFeaturedSkillsResponse.parse(skills));
});

router.get("/skills/categories", async (_req, res): Promise<void> => {
  await ensureSkillsLoaded();

  const skills = await db.select({ category: skillsTable.category }).from(skillsTable);

  const countMap = new Map<string, number>();
  for (const { category } of skills) {
    countMap.set(category, (countMap.get(category) ?? 0) + 1);
  }

  const categories = Array.from(countMap.entries()).map(([name, count]) => ({
    name,
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    count,
  }));

  res.json(ListSkillCategoriesResponse.parse(categories));
});

router.post("/skills/refresh", async (_req, res): Promise<void> => {
  lastFetchedAt = null;
  await refreshSkillsFromGitHub();
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(skillsTable);
  res.json({ ok: true, skillsLoaded: count });
});

// ─── Service-token auth helper ────────────────────────────────────────────────
function isServiceTokenRequest(req: Request): boolean {
  const envToken = process.env.OPENCLAW_SERVICE_TOKEN;
  if (!envToken) return false;
  const authHeader = req.headers.authorization ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  return bearer.length > 0 && bearer === envToken;
}

// ─── POST /skills — Create a skill (Archon catalog insert) ───────────────────
router.post("/skills", async (req: Request, res: Response): Promise<void> => {
  const serviceAuth = isServiceTokenRequest(req);
  const clerkAuth = !!(req as any).auth?.userId;
  if (!serviceAuth && !clerkAuth) {
    res.status(401).json({ error: "Unauthorized — provide a valid service token or Clerk JWT" });
    return;
  }

  const { name, slug, description, category, featured = false, tags = [], source = "archon", implementation, archonRunId } =
    req.body as { name?: string; slug?: string; description?: string; category?: string; featured?: boolean; tags?: string[]; source?: string; implementation?: string; archonRunId?: string };

  if (!name || !slug || !description || !category) {
    res.status(400).json({ error: "name, slug, description, and category are required" });
    return;
  }

  try {
    const [inserted] = await db
      .insert(skillsTable)
      .values({ name, slug, description, category, featured, tags: tags ?? [], source, implementation: implementation ?? null, archonRunId: archonRunId ?? null })
      .onConflictDoUpdate({
        target: skillsTable.slug,
        set: { name: sql`EXCLUDED.name`, description: sql`EXCLUDED.description`, category: sql`EXCLUDED.category`, featured: sql`EXCLUDED.featured`, tags: sql`EXCLUDED.tags`, source: sql`EXCLUDED.source`, implementation: sql`EXCLUDED.implementation`, archonRunId: sql`EXCLUDED.archon_run_id` },
      })
      .returning();
    res.status(201).json({ id: inserted.id, slug: inserted.slug, name: inserted.name });
  } catch (err: unknown) {
    res.status(500).json({ error: `Failed to insert skill: ${err instanceof Error ? err.message : String(err)}` });
  }
});

router.post("/skills/:id/benchmark", async (req: Request, res: Response): Promise<void> => {
  const skillId = parseInt(req.params.id);
  if (isNaN(skillId)) {
    res.status(400).json({ error: "Invalid skill id" });
    return;
  }
  const [skill] = await db.select().from(skillsTable).where(eq(skillsTable.id, skillId)).limit(1);
  if (!skill) {
    res.status(404).json({ error: "Skill not found" });
    return;
  }
  try {
    const run = await runBenchmark({
      skill_id: skill.id,
      skill_name: skill.name,
      skill_description: skill.description,
      skill_category: skill.category,
      test_suite: (["standard","adversarial","quick"].includes(req.query.suite as string) ? req.query.suite as "standard"|"adversarial"|"quick" : "standard"),
    });
    res.json({ benchmark_id: run.benchmark_id, status: run.status, skill_id: skillId });
  } catch (err: any) {
    res.status(503).json({ error: "Benchmark service unavailable", details: err?.message });
  }
});

router.get("/skills/:id/benchmark-result", async (req: Request, res: Response): Promise<void> => {
  const skillId = parseInt(req.params.id);
  if (isNaN(skillId)) {
    res.status(400).json({ error: "Invalid skill id" });
    return;
  }
  // Get latest benchmark from DB
  const results = await db
    .select()
    .from(skillBenchmarksTable)
    .where(eq(skillBenchmarksTable.skillId, skillId))
    .orderBy(skillBenchmarksTable.ranAt)
    .limit(1);

  if (!results.length) {
    res.json({ grade: null, overallScore: null, levelScores: null, status: "not_tested", message: "No benchmark run yet" });
    return;
  }
  res.json(results[0]);
});

router.get("/benchmark/:benchmarkId", async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await getBenchmarkResult(req.params["benchmarkId"] as string);
    res.json(result);
  } catch (err: any) {
    res.status(503).json({ error: "Benchmark service unavailable", details: err?.message });
  }
});

export default router;
