import { Router, type IRouter } from "express";
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

    await db.delete(skillsTable);

    for (let i = 0; i < parsed.length; i += 100) {
      const chunk = parsed.slice(i, i + 100);
      await db.insert(skillsTable).values(chunk);
    }

    lastFetchedAt = new Date();
  } finally {
    fetchInProgress = false;
  }
}

async function ensureSkillsLoaded(): Promise<void> {
  if (lastFetchedAt && Date.now() - lastFetchedAt.getTime() < SKILLS_TTL_MS) {
    return;
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(skillsTable);

  if (count === 0 || !lastFetchedAt) {
    await refreshSkillsFromGitHub();
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

router.post("/skills/:id/benchmark", async (req, res): Promise<void> => {
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
      test_suite: (req.query.suite as any) || "standard",
    });
    res.json({ benchmark_id: run.benchmark_id, status: run.status, skill_id: skillId });
  } catch (err: any) {
    res.status(503).json({ error: "Benchmark service unavailable", details: err?.message });
  }
});

router.get("/skills/:id/benchmark-result", async (req, res): Promise<void> => {
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
    res.json({ grade: null, overall_score: null, status: "not_tested", message: "No benchmark run yet" });
    return;
  }
  res.json(results[0]);
});

router.get("/benchmark/:benchmarkId", async (req, res): Promise<void> => {
  try {
    const result = await getBenchmarkResult(req.params.benchmarkId);
    res.json(result);
  } catch (err: any) {
    res.status(503).json({ error: "Benchmark service unavailable", details: err?.message });
  }
});

export default router;
