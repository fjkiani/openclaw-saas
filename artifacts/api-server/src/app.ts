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

// DB connectivity probe — no auth required
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

// CORS — allow the Render frontend and any localhost dev origin
const ALLOWED_ORIGINS = [
  "https://openclaw-saas-z2j8.onrender.com",
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];
app.use(cors({
  credentials: true,
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, Postman, server-to-server)
    if (!origin) return cb(null, true);
    const allowed = ALLOWED_ORIGINS.some((o) =>
      typeof o === "string" ? o === origin : o.test(origin)
    );
    cb(allowed ? null : new Error(`CORS: origin ${origin} not allowed`), allowed);
  },
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Clerk auth middleware — synchronous registration so req.auth is always
// populated before any route handler runs.
// clerkMiddleware() is safe to call even when CLERK_SECRET_KEY is missing:
// it will simply leave req.auth undefined (no throw).
if (process.env.CLERK_SECRET_KEY?.startsWith("sk_")) {
  app.use(clerkMiddleware());
  logger.info("Clerk auth middleware enabled.");
} else {
  logger.warn("CLERK_SECRET_KEY not set or invalid — Clerk auth disabled. Legal endpoints still work.");
}

app.use("/api", router);

// Global error handler
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
