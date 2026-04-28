import { Router, type IRouter } from "express";
import { eq, ilike, or } from "drizzle-orm";
import { db, skillsTable } from "@workspace/db";
import {
  ListSkillsQueryParams,
  ListSkillsResponse,
  ListFeaturedSkillsResponse,
  ListSkillCategoriesResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/skills", async (req, res): Promise<void> => {
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
  const skills = await db
    .select()
    .from(skillsTable)
    .where(eq(skillsTable.featured, true))
    .limit(12);
  res.json(ListFeaturedSkillsResponse.parse(skills));
});

router.get("/skills/categories", async (_req, res): Promise<void> => {
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

export default router;
