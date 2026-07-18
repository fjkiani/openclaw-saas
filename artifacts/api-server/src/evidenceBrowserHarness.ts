import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import evidenceRouter from "./routes/evidence.js";
import evidenceReviewRouter from "./routes/evidenceReview.js";

const app = express();
const port = Number(process.env.PORT ?? 4173);
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../openclaw-saas/dist/public");
app.use(express.json());
app.use("/api", evidenceRouter);
app.use("/api", evidenceReviewRouter);
app.use(express.static(publicDir));
app.use((_req, res) => res.sendFile(path.join(publicDir, "index.html")));
app.listen(port, "127.0.0.1", () => console.log(`Evidence browser harness listening on ${port}`));
