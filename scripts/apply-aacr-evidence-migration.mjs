#!/usr/bin/env node
import fs from "node:fs";
import { createRequire } from "node:module";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}
const requireFromDbPackage = createRequire(new URL("../lib/db/package.json", import.meta.url));
const { Pool } = requireFromDbPackage("pg");
const migration = new URL("../lib/db/drizzle/0008_aacr_evidence_explorer.sql", import.meta.url);
const sql = fs.readFileSync(migration, "utf8");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query(sql);
  console.log("AACR Evidence Explorer migration 0008 applied");
} finally {
  await pool.end();
}
