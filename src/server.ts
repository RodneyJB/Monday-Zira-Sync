import "dotenv/config";

import express from "express";
import path from "node:path";

import { config } from "./config.js";
import { apiRouter } from "./routes/api.js";

const app = express();
const publicDir = path.resolve(process.cwd(), "public");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api", apiRouter);

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API route not found" });
});

app.use((_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(config.PORT, () => {
  console.log(`Monday-Zira-Sync running on port ${config.PORT}`);
});
