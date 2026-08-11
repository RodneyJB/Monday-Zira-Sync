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

function extractAssetIdsFromFileColumnValue(rawValue: string): string[] {
  if (!rawValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue) as {
      files?: Array<Record<string, unknown>>;
      assets?: Array<Record<string, unknown>>;
    };

    const entries = [...(parsed.files ?? []), ...(parsed.assets ?? [])];
    return entries
      .map((entry) => {
        const value = entry.assetId ?? entry.asset_id ?? entry.id;
        if (typeof value === "number") {
          return String(value);
        }

        if (typeof value === "string") {
          return value;
        }

        return "";
      })
      .filter((entry) => entry.length > 0);
  } catch {
    return [];
  }
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
  return mondayItem.assets.filter((asset) => selectedAssetIds.has(asset.id));
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
  const jiraPriorities = await listJiraPriorities(jiraAccount);
  const priorityName = resolvePriorityFromStatusLabel({
    statusLabel,
    priorityNames: jiraPriorities.map((entry) => entry.name)
  });

  let issueKey = existing?.issueKey;
  let created = false;
  let usingExistingIssueKey = Boolean(issueKey);
  const mondayIdentityLabels = buildMondayIdentityLabels(boardId, itemId);

  if (!issueKey) {
    const matchedIssue = await findJiraIssueByLabels({
      account: jiraAccount,
      projectKey: mapping.projectKey,
      labels: mondayIdentityLabels
    });

    if (matchedIssue) {
      issueKey = matchedIssue.key;
    }
  }

  if (!issueKey) {
    const createdIssue = await createJiraIssue({
      account: jiraAccount,
      projectKey: mapping.projectKey,
      summary,
      description: `Created from Monday board ${mondayItem.boardName} (ID: ${mondayItem.boardId}), item ID: ${mondayItem.id}. Current status: ${statusLabel || "n/a"}.`,
      priorityName,
      mondayItemUrl,
      labels: mondayIdentityLabels
    });

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
        throw error;
      }

      const recreatedIssue = await createJiraIssue({
        account: jiraAccount,
        projectKey: mapping.projectKey,
        summary,
        description: `Recreated from Monday board ${mondayItem.boardName} (ID: ${mondayItem.boardId}), item ID: ${mondayItem.id}. Current status: ${statusLabel || "n/a"}.`,
        priorityName,
        mondayItemUrl,
        labels: mondayIdentityLabels
      });

      issueKey = recreatedIssue.key;
      created = true;
      usingExistingIssueKey = false;
    }
  }

  let attachmentCount = 0;
  const alreadyUploadedAssetIds = new Set(usingExistingIssueKey ? existing?.uploadedAssetIds ?? [] : []);
  const uploadedAssetIds = [...alreadyUploadedAssetIds];

  for (const asset of assetsToSync) {
    if (!asset.publicUrl || alreadyUploadedAssetIds.has(asset.id)) {
      continue;
    }

    const fileName = asset.name?.trim() || `asset-${asset.id}.${asset.fileExtension || "bin"}`;

    await uploadJiraAttachmentFromUrl({
      account: jiraAccount,
      issueIdOrKey: issueKey,
      fileUrl: asset.publicUrl,
      fileName
    });

    uploadedAssetIds.push(asset.id);
    attachmentCount += 1;
  }

  const statusSync = await applyJiraStatusFromMonday({
    account: jiraAccount,
    issueIdOrKey: issueKey,
    statusLabel,
    previousStatusLabel: existing?.lastStatusLabel
  });

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
