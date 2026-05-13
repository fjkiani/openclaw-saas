import express from "express";
import cors from "cors";
import { config } from "./config.js";
import router from "./routes.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(router);

app.listen(config.port, () => {
  console.log(`archon-factory running on :${config.port}`);
  console.log(`  OpenRouter model: ${config.codeModel}`);
  console.log(`  Benchmark service: ${config.benchmarkServiceUrl}`);
  console.log(`  Archon service: ${config.archonServiceUrl}`);
});

export default app;
