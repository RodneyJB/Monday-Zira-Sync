import { Router } from "express";
import { z } from "zod";

import { config } from "../config.js";
import { getBoardMapping, saveBoardMapping } from "../services/mappingStore.js";
import { listJiraProjects } from "../services/jiraService.js";
import {
  getMondayBoardStatusColumns,
  getMondayBoardSummary,
  getMondayMe
} from "../services/mondayService.js";
import { syncMondayItemToJira } from "../services/syncService.js";

const optionalTextField = z.preprocess(
  (value) => {
    if (typeof value !== "string") {
      return value;
    }

    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  },
  z.string().optional()
);

const saveMappingSchema = z.object({
  boardId: z.string().min(1),
  accountId: z.string().min(1),
  projectKey: z.string().min(1),
  projectName: z.string().min(1),
  syncTrigger: z.enum(["manual", "status_change"]).default("manual"),
  statusColumnId: optionalTextField,
  triggerStatusLabel: optionalTextField,
  keepSynced: z.boolean().default(true)
});

const syncItemSchema = z.object({
  boardId: z.string().min(1),
  itemId: z.string().min(1)
});

export const apiRouter = Router();

function asText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return "";
}

function parseEventValue(rawValue: unknown): Record<string, unknown> {
  if (rawValue && typeof rawValue === "object") {
    return rawValue as Record<string, unknown>;
  }

  if (typeof rawValue === "string") {
    try {
      const parsed = JSON.parse(rawValue) as unknown;
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }

  return {};
}

function extractStatusLabelFromEvent(event: Record<string, unknown>): string {
  const value = parseEventValue(event.value);
  const label = value.label;

  if (label && typeof label === "object") {
    const text = asText((label as Record<string, unknown>).text);
    if (text) {
      return text;
    }
  }

  return asText(value.label) || asText(value.text);
}

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

apiRouter.get("/monday/status-columns", async (req, res) => {
  const boardId = req.query.boardId;

  if (typeof boardId !== "string" || boardId.length === 0) {
    res.status(400).json({ error: "boardId query parameter is required" });
    return;
  }

  try {
    const columns = await getMondayBoardStatusColumns(boardId);
    res.json({ columns });
  } catch (error) {
    const details = error instanceof Error ? error.message : "Unknown error";
    res.status(502).json({ error: "Could not fetch Monday status columns", details });
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
    const result = await syncMondayItemToJira({ ...parsed.data, keepSynced: true });
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

  const event = (req.body?.event ?? {}) as Record<string, unknown>;
  const boardId =
    asText(event.boardId) || asText(event.board_id) || asText(event.boardid) || asText(event.board_id);
  const itemId =
    asText(event.pulseId) ||
    asText(event.pulse_id) ||
    asText(event.itemId) ||
    asText(event.item_id) ||
    asText(event.pulseid);

  if (boardId && itemId) {
    try {
      const mapping = await getBoardMapping(boardId);
      if (!mapping) {
        res.status(202).json({ received: true, skipped: "No board mapping" });
        return;
      }

      if (mapping.syncTrigger === "manual") {
        res.status(202).json({ received: true, skipped: "Manual trigger mode" });
        return;
      }

      const eventColumnId = asText(event.columnId) || asText(event.column_id);
      if (!eventColumnId) {
        res.status(202).json({ received: true, skipped: "Not a column change event" });
        return;
      }

      if (mapping.statusColumnId && eventColumnId !== mapping.statusColumnId) {
        res.status(202).json({ received: true, skipped: "Different column" });
        return;
      }

      const statusLabel = extractStatusLabelFromEvent(event);
      if (
        mapping.triggerStatusLabel &&
        statusLabel.trim().toLowerCase() !== mapping.triggerStatusLabel.trim().toLowerCase()
      ) {
        res.status(202).json({ received: true, skipped: "Status label mismatch" });
        return;
      }

      await syncMondayItemToJira({ boardId, itemId, keepSynced: mapping.keepSynced });
    } catch (error) {
      const details = error instanceof Error ? error.message : "Unknown error";
      console.error("Webhook sync failed", { boardId, itemId, details });
    }
  }

  res.status(202).json({ received: true });
});
