import { config } from "../config.js";
import {
  applyJiraStatusFromMonday,
  createJiraIssue,
  findJiraIssueByLabels,
  listJiraPriorities,
  updateJiraIssueSummary,
  uploadJiraAttachmentFromUrl
} from "./jiraService.js";
import { getBoardMapping } from "./mappingStore.js";
import { getMondayItemForSync } from "./mondayService.js";
import { getSyncedItem, setSyncedItem } from "./syncStateStore.js";
import { translateText } from "./translationService.js";

export type SyncResult = {
  issueKey: string;
  created: boolean;
  attachmentCount: number;
  statusSync: {
    action: "transitioned" | "labeled" | "skipped";
    details: string;
  };
};

function isMissingJiraIssueError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const response = (error as { response?: { status?: number } }).response;
  const status = response?.status;
  return status === 404 || status === 410;
}

function isJiraLookupUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const response = (error as { response?: { status?: number } }).response;
  const status = response?.status;
  return (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 405 ||
    status === 409 ||
    status === 410 ||
    status === 429
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const inFlightSyncs = new Map<string, Promise<SyncResult>>();

function makeSyncKey(boardId: string, itemId: string): string {
  return `${boardId}:${itemId}`;
}

function buildMondayItemUrl(boardId: string, itemId: string): string {
  const baseUrl = config.MONDAY_ACCOUNT_BASE_URL.replace(/\/$/, "");
  const mapping = `boards/${boardId}/pulses/${itemId}`;
  return `${baseUrl}/${mapping}`;
}

function applyNameTranslations(name: string, translations: Record<string, string>): string {
  let output = name;
  for (const [from, to] of Object.entries(translations)) {
    if (!from) {
      continue;
    }

    output = output.split(from).join(to);
  }

  return output;
}

function slugLabelSegment(input: string, maxLength = 40): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug.slice(0, maxLength) || "na";
}

function buildMondayIdentityLabels(boardId: string, itemId: string): string[] {
  return [
    `monday-board-${slugLabelSegment(boardId)}`,
    `monday-item-${slugLabelSegment(itemId)}`
  ];
}

async function resolveSummaryFromMapping(
  mondayItem: Awaited<ReturnType<typeof getMondayItemForSync>>,
  mapping: Awaited<ReturnType<typeof getBoardMapping>>
): Promise<string> {
  const baseName =
    mapping?.nameSource === "text_column" && mapping.nameColumnId
      ? mondayItem.columnValues.find((column) => column.id === mapping.nameColumnId)?.text || mondayItem.name
      : mondayItem.name;

  const translated = applyNameTranslations(baseName, mapping?.nameTranslations ?? {});
  const normalized = translated.trim() || mondayItem.name;
  return translateText({
    text: normalized,
    targetLanguage: mapping?.targetLanguage ?? "none"
  });
}

export function shouldUploadAttachmentsForSync(input: {
  created: boolean;
  existingIssueKey?: string;
  attachmentSource?: "item_assets" | "file_column";
}): boolean {
  if (input.attachmentSource === "file_column" && input.existingIssueKey) {
    return true;
  }

  if (input.created) {
    return input.attachmentSource === "file_column";
  }

  return Boolean(input.existingIssueKey);
}

export function extractAssetIdsFromFileColumnValue(rawValue: unknown): string[] {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return [];
  }

  const seen = new Set<string>();

  const collectIds = (value: unknown): void => {
    if (value === undefined || value === null) {
      return;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return;
      }

      try {
        const parsed = JSON.parse(trimmed) as unknown;
        collectIds(parsed);
        return;
      } catch {
        // Ignore non-JSON strings and continue with plain text fallback.
      }
    }

    if (Array.isArray(value)) {
      value.forEach((entry) => collectIds(entry));
      return;
    }

    if (typeof value === "object") {
      const record = value as Record<string, unknown>;

      for (const key of ["assetId", "asset_id", "fileId", "file_id", "id", "uuid", "value"]) {
        const candidate = record[key];

        if (typeof candidate === "string" && candidate.trim()) {
          seen.add(candidate.trim());
        } else if (typeof candidate === "number") {
          seen.add(String(candidate));
        }
      }

      for (const nested of Object.values(record)) {
        collectIds(nested);
      }
    }
  };

  collectIds(rawValue);
  return [...seen];
}

function inferAttachmentExtension(fileName: string | undefined): string {
  if (!fileName) {
    return "bin";
  }

  const clean = fileName.split("?")[0].split("#")[0];
  const extension = clean.includes(".") ? clean.split(".").pop() : "";
  return extension && extension.length <= 8 ? extension : "bin";
}

function extractAttachmentCandidatesFromFileColumnValue(rawValue: unknown): Array<{
  id: string;
  name: string;
  publicUrl: string;
  fileExtension: string;
}> {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return [];
  }

  const candidates: Array<{
    id: string;
    name: string;
    publicUrl: string;
    fileExtension: string;
  }> = [];
  const seen = new Set<string>();

  const collect = (value: unknown): void => {
    if (value === undefined || value === null) {
      return;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return;
      }

      try {
        const parsed = JSON.parse(trimmed) as unknown;
        collect(parsed);
        return;
      } catch {
        if (/^https?:\/\//i.test(trimmed)) {
          const key = `url:${trimmed}`;
          if (!seen.has(key)) {
            seen.add(key);
            candidates.push({
              id: key,
              name: `attachment-${Date.now()}`,
              publicUrl: trimmed,
              fileExtension: "bin"
            });
          }
        }
      }

      return;
    }

    if (Array.isArray(value)) {
      value.forEach((entry) => collect(entry));
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    const record = value as Record<string, unknown>;
    const possibleUrl = [
      record.publicUrl,
      record.public_url,
      record.fileUrl,
      record.file_url,
      record.url,
      record.downloadUrl,
      record.download_url
    ].find((entry): entry is string => typeof entry === "string" && /^https?:\/\//i.test(entry));

    if (possibleUrl) {
      const idCandidate =
        [
          record.assetId,
          record.asset_id,
          record.fileId,
          record.file_id,
          record.id,
          record.uuid,
          record.value,
          possibleUrl
        ].find((entry): entry is string | number => typeof entry === "string" || typeof entry === "number");

      const id = typeof idCandidate === "string" ? idCandidate.trim() : String(idCandidate ?? possibleUrl);
      const name = typeof record.name === "string" ? record.name : `attachment-${id}`;
      const fileExtension = inferAttachmentExtension(typeof record.name === "string" ? record.name : undefined);
      const key = `url:${possibleUrl}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push({
          id,
          name,
          publicUrl: possibleUrl,
          fileExtension
        });
      }
    }

    for (const key of ["assetId", "asset_id", "fileId", "file_id", "id", "uuid", "value"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim()) {
        const normalized = candidate.trim();
        if (!seen.has(`id:${normalized}`)) {
          seen.add(`id:${normalized}`);
        }
      }
    }

    for (const nested of Object.values(record)) {
      collect(nested);
    }
  };

  collect(rawValue);
  return candidates;
}

function resolveAssetsFromMapping(
  mondayItem: Awaited<ReturnType<typeof getMondayItemForSync>>,
  mapping: Awaited<ReturnType<typeof getBoardMapping>>
) {
  if (mapping?.attachmentSource !== "file_column" || !mapping.attachmentColumnId) {
    return mondayItem.assets;
  }

  const fileColumn = mondayItem.columnValues.find((column) => column.id === mapping.attachmentColumnId);
  if (!fileColumn?.value) {
    return [];
  }

  const selectedAssetIds = new Set(extractAssetIdsFromFileColumnValue(fileColumn.value));
  const matchedAssets = mondayItem.assets.filter((asset) => selectedAssetIds.has(asset.id));
  const directCandidates = extractAttachmentCandidatesFromFileColumnValue(fileColumn.value);
  const directUrls = new Set(directCandidates.map((candidate) => candidate.publicUrl));
  const byDirectUrl = directCandidates.filter((candidate) => candidate.publicUrl && !matchedAssets.some((asset) => asset.publicUrl === candidate.publicUrl));

  const merged = [...matchedAssets, ...byDirectUrl.map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    publicUrl: candidate.publicUrl,
    fileExtension: candidate.fileExtension
  }))];

  const unique = new Map<string, (typeof merged)[number]>();
  for (const asset of merged) {
    unique.set(asset.publicUrl || asset.id, asset);
  }

  return [...unique.values()].filter((asset) => Boolean(asset.publicUrl));
}

function resolvePriorityFromStatusLabel(input: {
  statusLabel: string;
  priorityNames: string[];
}): string | undefined {
  const status = input.statusLabel.trim();
  if (!status) {
    return undefined;
  }

  const priorities = input.priorityNames;
  const lowerStatus = status.toLowerCase();

  const exact = priorities.find((priority) => priority.toLowerCase() === lowerStatus);
  if (exact) {
    return exact;
  }

  const pickFirstAvailable = (choices: string[]): string | undefined => {
    for (const choice of choices) {
      const found = priorities.find((priority) => priority.toLowerCase() === choice);
      if (found) {
        return found;
      }
    }

    return undefined;
  };

  if (/(done|closed|resolved|finish)/i.test(status)) {
    return pickFirstAvailable(["low", "lowest", "medium"]);
  }

  if (/(sync jira|urgent|critical|blocker|hotfix)/i.test(status)) {
    return pickFirstAvailable(["highest", "high", "medium"]);
  }

  if (/(progress|working|doing|wip)/i.test(status)) {
    return pickFirstAvailable(["high", "medium"]);
  }

  if (/(todo|to do|open|ready)/i.test(status)) {
    return pickFirstAvailable(["medium", "high", "low"]);
  }

  return pickFirstAvailable(["medium", "high", "low", "highest", "lowest"]);
}

async function runSyncMondayItemToJira(input: {
  boardId: string;
  itemId: string;
  keepSynced?: boolean;
  statusLabel?: string;
}): Promise<SyncResult> {
  const { boardId, itemId } = input;
  const keepSynced = input.keepSynced ?? true;

  const mapping = await getBoardMapping(boardId);
  if (!mapping) {
    throw new Error("No Jira mapping configured for this board.");
  }

  const jiraAccount = config.jiraAccounts.find((account) => account.id === mapping.accountId);
  if (!jiraAccount) {
    throw new Error("Mapped Jira account not found in configuration.");
  }

  const existing = await getSyncedItem(boardId, itemId);
  if (existing && !keepSynced) {
    return {
      issueKey: existing.issueKey,
      created: false,
      attachmentCount: 0,
      statusSync: {
        action: "skipped",
        details: "keepSynced is disabled and item was already synced"
      }
    };
  }

  const mondayItem = await getMondayItemForSync(itemId);
  const summary = await resolveSummaryFromMapping(mondayItem, mapping);
  const assetsToSync = resolveAssetsFromMapping(mondayItem, mapping);
  const mondayItemUrl = buildMondayItemUrl(mondayItem.boardId, mondayItem.id);
  const liveStatusLabel = mapping.statusColumnId
    ? mondayItem.columnValues.find((column) => column.id === mapping.statusColumnId)?.text || ""
    : "";
  const statusLabel = (liveStatusLabel || input.statusLabel || "").trim();
  let jiraPriorities;
  try {
    jiraPriorities = await listJiraPriorities(jiraAccount);
  } catch (error) {
    throw new Error(`Jira priorities lookup failed: ${errorMessage(error)}`);
  }
  const priorityName = resolvePriorityFromStatusLabel({
    statusLabel,
    priorityNames: jiraPriorities.map((entry) => entry.name)
  });

  let issueKey = existing?.issueKey;
  let created = false;
  let usingExistingIssueKey = Boolean(issueKey);
  const mondayIdentityLabels = buildMondayIdentityLabels(boardId, itemId);

  if (!issueKey) {
    try {
      const matchedIssue = await findJiraIssueByLabels({
        account: jiraAccount,
        projectKey: mapping.projectKey,
        labels: mondayIdentityLabels,
        boardId,
        itemId
      });

      if (matchedIssue) {
        issueKey = matchedIssue.key;
      }
    } catch (error) {
      if (!isJiraLookupUnavailableError(error)) {
        throw error;
      }

      const message =
        "Jira issue lookup is unavailable for this project; refusing to create a new issue to avoid duplicates.";

      console.warn("Jira lookup by labels unavailable; skipping sync to avoid duplicate issue creation", {
        boardId,
        itemId,
        projectKey: mapping.projectKey,
        detail: errorMessage(error)
      });

      throw new Error(message);
    }
  }

  if (!issueKey) {
      let createdIssue;
      try {
        createdIssue = await createJiraIssue({
          account: jiraAccount,
          projectKey: mapping.projectKey,
          summary,
          description: `Created from Monday board ${mondayItem.boardName} (ID: ${mondayItem.boardId}), item ID: ${mondayItem.id}. Current status: ${statusLabel || "n/a"}.`,
          priorityName,
          mondayItemUrl,
          labels: mondayIdentityLabels
        });
      } catch (error) {
        throw new Error(`Jira issue creation failed: ${errorMessage(error)}`);
      }

    issueKey = createdIssue.key;
    created = true;
    usingExistingIssueKey = false;
  } else {
    try {
      await updateJiraIssueSummary({
        account: jiraAccount,
        issueIdOrKey: issueKey,
        summary,
        description: `Updated from Monday board ${mondayItem.boardName} (ID: ${mondayItem.boardId}), item ID: ${mondayItem.id}. Current status: ${statusLabel || "n/a"}.`,
        priorityName,
        mondayItemUrl
      });
    } catch (error) {
      if (!isMissingJiraIssueError(error)) {
        throw new Error(`Jira issue update failed: ${errorMessage(error)}`);
      }

      let recreatedIssue;
      try {
        recreatedIssue = await createJiraIssue({
          account: jiraAccount,
          projectKey: mapping.projectKey,
          summary,
          description: `Recreated from Monday board ${mondayItem.boardName} (ID: ${mondayItem.boardId}), item ID: ${mondayItem.id}. Current status: ${statusLabel || "n/a"}.`,
          priorityName,
          mondayItemUrl,
          labels: mondayIdentityLabels
        });
      } catch (createError) {
        throw new Error(`Jira issue recreate failed: ${errorMessage(createError)}`);
      }

      issueKey = recreatedIssue.key;
      created = true;
      usingExistingIssueKey = false;
    }
  }

  let attachmentCount = 0;
  const shouldUploadAttachments = shouldUploadAttachmentsForSync({
    created,
    existingIssueKey: issueKey || undefined,
    attachmentSource: mapping.attachmentSource
  });
  const alreadyUploadedAssetIds = new Set(usingExistingIssueKey ? existing?.uploadedAssetIds ?? [] : []);
  const uploadedAssetIds = [...alreadyUploadedAssetIds];

  if (shouldUploadAttachments) {
    for (const asset of assetsToSync) {
      if (!asset.publicUrl || alreadyUploadedAssetIds.has(asset.id)) {
        continue;
      }

      const fileName = asset.name?.trim() || `asset-${asset.id}.${asset.fileExtension || "bin"}`;

      try {
        await uploadJiraAttachmentFromUrl({
          account: jiraAccount,
          issueIdOrKey: issueKey,
          fileUrl: asset.publicUrl,
          fileName
        });

        uploadedAssetIds.push(asset.id);
        attachmentCount += 1;
      } catch (error) {
        console.warn("Skipping Monday asset upload for Jira", {
          boardId,
          itemId,
          assetId: asset.id,
          fileName,
          fileUrl: asset.publicUrl,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  let statusSync;
  try {
    statusSync = await applyJiraStatusFromMonday({
      account: jiraAccount,
      issueIdOrKey: issueKey,
      statusLabel,
      previousStatusLabel: existing?.lastStatusLabel
    });
  } catch (error) {
    throw new Error(`Jira status sync failed: ${errorMessage(error)}`);
  }

  await setSyncedItem({
    boardId,
    itemId,
    issueKey,
    uploadedAssetIds,
    lastStatusLabel: statusSync.appliedLabel
  });

  return {
    issueKey,
    created,
    attachmentCount,
    statusSync
  };
}

export async function syncMondayItemToJira(input: {
  boardId: string;
  itemId: string;
  keepSynced?: boolean;
  statusLabel?: string;
}): Promise<SyncResult> {
  const key = makeSyncKey(input.boardId, input.itemId);
  const inFlight = inFlightSyncs.get(key);

  if (inFlight) {
    return inFlight;
  }

  const running = runSyncMondayItemToJira(input);
  inFlightSyncs.set(key, running);

  try {
    return await running;
  } finally {
    if (inFlightSyncs.get(key) === running) {
      inFlightSyncs.delete(key);
    }
  }
}
