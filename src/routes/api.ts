import { Router } from "express";
import { z } from "zod";

import { config } from "../config.js";
import { getBoardMapping, saveBoardMapping } from "../services/mappingStore.js";
import { listJiraProjects } from "../services/jiraService.js";
import {
  getMondayBoardSyncColumns,
  getMondayBoardStatusColumns,
  getMondayBoardSummary,
  getMondayMe
} from "../services/mondayService.js";
import { clearSyncedItemsForBoard, getSyncedItem } from "../services/syncStateStore.js";
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

const optionalTranslationMap = z.preprocess(
  (value) => {
    if (!value || value === "") {
      return undefined;
    }

    if (typeof value === "object") {
      return value;
    }

    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }

    return value;
  },
  z.record(z.string(), z.string()).optional()
);

const saveMappingSchema = z.object({
  boardId: z.string().min(1),
  boardViewId: optionalTextField,
  accountId: z.string().min(1),
  projectKey: z.string().min(1),
  projectName: z.string().min(1),
  syncTrigger: z.enum(["manual", "status_change"]).default("manual"),
  statusColumnId: optionalTextField,
  triggerStatusLabel: optionalTextField,
  keepSynced: z.boolean().default(true),
  nameSource: z.enum(["item_name", "text_column"]).default("item_name"),
  nameColumnId: optionalTextField,
  attachmentSource: z.enum(["item_assets", "file_column"]).default("item_assets"),
  attachmentColumnId: optionalTextField,
  nameTranslations: optionalTranslationMap.default({}),
  targetLanguage: z
    .enum([
      "none",
      "en",
      "de",
      "fr",
      "es",
      "it",
      "nl",
      "pl",
      "pt",
      "sv",
      "da",
      "no",
      "fi",
      "cs",
      "sk",
      "sl",
      "hr",
      "hu",
      "ro",
      "bg",
      "el",
      "tr"
    ])
    .default("none")
});

const syncItemSchema = z.object({
  boardId: z.string().min(1),
  itemId: z.string().min(1)
});

const resetBoardSchema = z.object({
  boardId: z.string().min(1)
});

type WebhookDebugEvent = {
  at: string;
  boardId: string;
  itemId: string;
  eventColumnId: string;
  statusLabel: string;
  decision: string;
  details?: string;
};

const webhookDebugEvents: WebhookDebugEvent[] = [];

function addWebhookDebugEvent(event: WebhookDebugEvent): void {
  webhookDebugEvents.unshift(event);
  if (webhookDebugEvents.length > 100) {
    webhookDebugEvents.length = 100;
  }
}

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

function parseMaybeJsonObject(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object") {
    return input as Record<string, unknown>;
  }

  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }

  return {};
}

function extractWebhookChallenge(body: unknown, query: unknown): string {
  const bodyObj = parseMaybeJsonObject(body);
  const dataObj = parseMaybeJsonObject(bodyObj.data);
  const payloadObj = parseMaybeJsonObject(bodyObj.payload);
  const eventObj = parseMaybeJsonObject(bodyObj.event);
  const queryObj = parseMaybeJsonObject(query);

  const challengeCandidates = [
    bodyObj.challenge,
    dataObj.challenge,
    payloadObj.challenge,
    eventObj.challenge,
    queryObj.challenge,
    typeof body === "string" ? body.trim() : ""
  ];

  for (const candidate of challengeCandidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return "";
}

function respondWithWebhookChallenge(reqBody: unknown, reqQuery: unknown, res: { status: (code: number) => { json: (payload: unknown) => void } }): boolean {
  const challenge = extractWebhookChallenge(reqBody, reqQuery);
  if (!challenge) {
    return false;
  }

  // Monday webhook URL validation expects the challenge echoed as JSON.
  res.status(200).json({ challenge });
  return true;
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

  if (typeof label === "string") {
    return label;
  }

  const direct =
    asText(value.text) ||
    asText(value.label_text) ||
    asText(event.statusLabel) ||
    asText(event.status_label) ||
    asText(event.label) ||
    asText(event.value);

  return direct;
}

function extractEventColumnId(event: Record<string, unknown>): string {
  const parsedValue = parseEventValue(event.value);

  return (
    asText(event.columnId) ||
    asText(event.column_id) ||
    asText(event.columnid) ||
    asText(parsedValue.column_id) ||
    asText(parsedValue.columnId) ||
    asText(parsedValue.id)
  );
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

apiRouter.get("/monday/sync-columns", async (req, res) => {
  const boardId = req.query.boardId;

  if (typeof boardId !== "string" || boardId.length === 0) {
    res.status(400).json({ error: "boardId query parameter is required" });
    return;
  }

  try {
    const columns = await getMondayBoardSyncColumns(boardId);
    res.json({ columns });
  } catch (error) {
    const details = error instanceof Error ? error.message : "Unknown error";
    res.status(502).json({ error: "Could not fetch Monday sync columns", details });
  }
});

apiRouter.get("/monday/webhook-events", (req, res) => {
  const limitRaw = req.query.limit;
  const parsedLimit = typeof limitRaw === "string" ? Number.parseInt(limitRaw, 10) : 20;
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 20;

  res.json({ events: webhookDebugEvents.slice(0, limit) });
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

  const existing = await getBoardMapping(parsed.data.boardId);
  let resetSyncedItems = false;
  let resetReason = "";
  let resetCount = 0;

  if (existing) {
    const targetChanged =
      existing.accountId !== parsed.data.accountId || existing.projectKey !== parsed.data.projectKey;
    const viewChanged =
      Boolean(existing.boardViewId) &&
      Boolean(parsed.data.boardViewId) &&
      existing.boardViewId !== parsed.data.boardViewId;

    if (targetChanged || viewChanged) {
      resetSyncedItems = true;
      resetReason = targetChanged ? "Jira target changed (account/project)" : "Board view changed";
      resetCount = await clearSyncedItemsForBoard(parsed.data.boardId);
    }
  }

  const mapping = await saveBoardMapping(parsed.data);
  res.status(201).json({ mapping, resetSyncedItems, resetReason, resetCount });
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

apiRouter.post("/sync/reset-board", async (req, res) => {
  const parsed = resetBoardSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const count = await clearSyncedItemsForBoard(parsed.data.boardId);
  res.status(200).json({ reset: true, boardId: parsed.data.boardId, count });
});

apiRouter.all("/monday/webhook", async (req, res) => {
  if (respondWithWebhookChallenge(req.body, req.query, res)) {
    return;
  }

  if (req.method.toUpperCase() !== "POST") {
    if (req.method.toUpperCase() === "HEAD") {
      res.status(200).end();
      return;
    }

    res.status(200).json({ ok: true });
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
  const eventColumnId = extractEventColumnId(event);
  const statusLabel = extractStatusLabelFromEvent(event);

  if (boardId && itemId) {
    try {
      const mapping = await getBoardMapping(boardId);
      if (!mapping) {
        addWebhookDebugEvent({
          at: new Date().toISOString(),
          boardId,
          itemId,
          eventColumnId,
          statusLabel,
          decision: "skipped",
          details: "No board mapping"
        });
        res.status(202).json({ received: true, skipped: "No board mapping" });
        return;
      }

      if (mapping.syncTrigger === "manual") {
        addWebhookDebugEvent({
          at: new Date().toISOString(),
          boardId,
          itemId,
          eventColumnId,
          statusLabel,
          decision: "skipped",
          details: "Manual trigger mode"
        });
        res.status(202).json({ received: true, skipped: "Manual trigger mode" });
        return;
      }

      if (mapping.statusColumnId && eventColumnId !== mapping.statusColumnId) {
        addWebhookDebugEvent({
          at: new Date().toISOString(),
          boardId,
          itemId,
          eventColumnId,
          statusLabel,
          decision: "skipped",
          details: `Different column (${eventColumnId || "unknown"})`
        });
        res.status(202).json({ received: true, skipped: "Different column" });
        return;
      }

      const existingSyncedItem = await getSyncedItem(boardId, itemId);
      const shouldEnforceTriggerLabel = !(existingSyncedItem && mapping.keepSynced);

      if (
        shouldEnforceTriggerLabel &&
        mapping.triggerStatusLabel &&
        statusLabel &&
        statusLabel.trim().toLowerCase() !== mapping.triggerStatusLabel.trim().toLowerCase()
      ) {
        addWebhookDebugEvent({
          at: new Date().toISOString(),
          boardId,
          itemId,
          eventColumnId,
          statusLabel,
          decision: "skipped",
          details: `Status mismatch (${statusLabel})`
        });
        res.status(202).json({ received: true, skipped: "Status label mismatch" });
        return;
      }

      const result = await syncMondayItemToJira({
        boardId,
        itemId,
        keepSynced: mapping.keepSynced,
        statusLabel
      });
      addWebhookDebugEvent({
        at: new Date().toISOString(),
        boardId,
        itemId,
        eventColumnId,
        statusLabel,
        decision: "synced",
        details: `Issue ${result.issueKey} (created=${String(result.created)}, attachments=${String(
          result.attachmentCount
        )}, status=${result.statusSync.action}: ${result.statusSync.details})`
      });
    } catch (error) {
      const details = error instanceof Error ? error.message : "Unknown error";
      addWebhookDebugEvent({
        at: new Date().toISOString(),
        boardId,
        itemId,
        eventColumnId,
        statusLabel,
        decision: "error",
        details
      });
      console.error("Webhook sync failed", { boardId, itemId, details });
    }
  } else {
    addWebhookDebugEvent({
      at: new Date().toISOString(),
      boardId,
      itemId,
      eventColumnId,
      statusLabel,
      decision: "ignored",
      details: "Missing boardId or itemId in webhook payload"
    });
  }

  res.status(202).json({ received: true });
});
