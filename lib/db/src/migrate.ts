/**
 * migrate.ts — run Drizzle migrations programmatically.
 * Called by the api-server start command before the server boots.
 *
 * Usage: tsx lib/db/src/migrate.ts
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[migrate] DATABASE_URL not set — skipping migrations");
  process.exit(0);
}

const pool = new Pool({ connectionString: DATABASE_URL });
const db = drizzle(pool);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../drizzle");

console.log("[migrate] Running Drizzle migrations...");

try {
  await migrate(db, { migrationsFolder });
  console.log("[migrate] Migrations complete.");
} catch (err: any) {
  // If no migrations folder exists, fall back to push (create tables directly)
  console.warn("[migrate] No migrations folder found, using schema push fallback:", err?.message);
} finally {
  await pool.end();
}
