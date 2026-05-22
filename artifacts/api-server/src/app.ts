import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Health check BEFORE Clerk middleware so it works even without CLERK_SECRET_KEY
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// DB connectivity probe — no auth required, useful for diagnosing startup issues
app.get("/dbz", async (_req, res) => {
  try {
    const { pool } = await import("@workspace/db");
    const client = await pool.connect();
    const result = await client.query("SELECT current_database(), version()");
    client.release();
    res.json({ ok: true, db: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message, cause: err.cause?.message });
  }
});

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Guard Clerk middleware — skip if CLERK_SECRET_KEY is not a real key.
// This allows the API to start and serve /api/v1/legal/* endpoints without auth
// when Clerk is not yet configured (e.g., fresh deployment before key is set).
const clerkKeyValid = process.env.CLERK_SECRET_KEY?.startsWith("sk_");
if (clerkKeyValid) {
  app.use(clerkMiddleware());
} else {
  logger.warn("CLERK_SECRET_KEY not set or invalid — Clerk auth middleware disabled. Set a real key to enable auth.");
}

app.use("/api", router);

// Global error handler — catches unhandled errors from async route handlers
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error & { cause?: Error; query?: string }, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, "Unhandled route error");
  const cause = (err.cause as any)?.message ?? String(err.cause ?? "");
  res.status(500).json({
    error: err.message ?? "Internal server error",
    ...(cause ? { cause } : {}),
    ...(err.query ? { query: err.query } : {}),
  });
});

export default app;
