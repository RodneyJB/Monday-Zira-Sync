import { Router } from "express";
import { z } from "zod";

import { config } from "../config.js";
import { getBoardMapping, saveBoardMapping } from "../services/mappingStore.js";
import { listJiraProjects } from "../services/jiraService.js";
import { getMondayBoardSummary, getMondayMe } from "../services/mondayService.js";
import { syncMondayItemToJira } from "../services/syncService.js";

const saveMappingSchema = z.object({
  boardId: z.string().min(1),
  accountId: z.string().min(1),
  projectKey: z.string().min(1),
  projectName: z.string().min(1)
});

const syncItemSchema = z.object({
  boardId: z.string().min(1),
  itemId: z.string().min(1)
});

export const apiRouter = Router();

apiRouter.get("/monday/me", async (_req, res) => {
  try {
    const me = await getMondayMe();
    res.json({ me });
  } catch (error) {
    const details = error instanceof Error ? error.message : "Unknown error";
    res.status(502).json({ error: "Could not reach Monday API", details });
  }
});

apiRouter.get("/monday/board", async (req, res) => {
  const boardId = req.query.boardId;

  if (typeof boardId !== "string" || boardId.length === 0) {
    res.status(400).json({ error: "boardId query parameter is required" });
    return;
  }

  try {
    const board = await getMondayBoardSummary(boardId);
    res.json({ board });
  } catch (error) {
    const details = error instanceof Error ? error.message : "Unknown error";
    res.status(502).json({ error: "Could not fetch Monday board", details });
  }
});

apiRouter.get("/jira/accounts", (_req, res) => {
  const accounts = config.jiraAccounts.map((account) => ({
    id: account.id,
    name: account.name,
    baseUrl: account.baseUrl
  }));

  res.json({ accounts });
});

apiRouter.get("/jira/projects", async (req, res) => {
  const accountId = req.query.accountId;

  if (typeof accountId !== "string" || accountId.length === 0) {
    res.status(400).json({ error: "accountId query parameter is required" });
    return;
  }

  const account = config.jiraAccounts.find((item) => item.id === accountId);

  if (!account) {
    res.status(404).json({ error: "Jira account not found" });
    return;
  }

  try {
    const projects = await listJiraProjects(account);
    res.json({ projects });
  } catch (error) {
    const details = error instanceof Error ? error.message : "Unknown error";
    res.status(502).json({ error: "Could not fetch Jira projects", details });
  }
});

apiRouter.get("/mapping", async (req, res) => {
  const boardId = req.query.boardId;

  if (typeof boardId !== "string" || boardId.length === 0) {
    res.status(400).json({ error: "boardId query parameter is required" });
    return;
  }

  const mapping = await getBoardMapping(boardId);
  res.json({ mapping });
});

apiRouter.post("/mapping", async (req, res) => {
  const parsed = saveMappingSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const account = config.jiraAccounts.find((item) => item.id === parsed.data.accountId);
  if (!account) {
    res.status(404).json({ error: "Jira account not found" });
    return;
  }

  const mapping = await saveBoardMapping(parsed.data);
  res.status(201).json({ mapping });
});

apiRouter.post("/sync/item", async (req, res) => {
  const parsed = syncItemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const result = await syncMondayItemToJira(parsed.data);
    res.status(200).json({ result });
  } catch (error) {
    const details = error instanceof Error ? error.message : "Unknown error";
    res.status(502).json({ error: "Could not sync Monday item to Jira", details });
  }
});

apiRouter.post("/monday/webhook", async (req, res) => {
  const challenge = req.body?.challenge;
  if (typeof challenge === "string") {
    res.status(200).json({ challenge });
    return;
  }

  const event = req.body?.event;
  const boardId = String(event?.boardId ?? event?.board_id ?? "");
  const itemId = String(event?.pulseId ?? event?.pulse_id ?? event?.itemId ?? event?.item_id ?? "");

  if (boardId && itemId) {
    try {
      await syncMondayItemToJira({ boardId, itemId });
    } catch (error) {
      const details = error instanceof Error ? error.message : "Unknown error";
      console.error("Webhook sync failed", { boardId, itemId, details });
    }
  }

  res.status(202).json({ received: true });
});
