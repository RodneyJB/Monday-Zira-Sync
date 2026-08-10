import { config } from "../config.js";
import {
  createJiraIssue,
  updateJiraIssueSummary,
  uploadJiraAttachmentFromUrl
} from "./jiraService.js";
import { getBoardMapping } from "./mappingStore.js";
import { getMondayItemForSync } from "./mondayService.js";
import { getSyncedItem, setSyncedItem } from "./syncStateStore.js";

export type SyncResult = {
  issueKey: string;
  created: boolean;
  attachmentCount: number;
};

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

function resolveSummaryFromMapping(
  mondayItem: Awaited<ReturnType<typeof getMondayItemForSync>>,
  mapping: Awaited<ReturnType<typeof getBoardMapping>>
): string {
  const baseName =
    mapping?.nameSource === "text_column" && mapping.nameColumnId
      ? mondayItem.columnValues.find((column) => column.id === mapping.nameColumnId)?.text || mondayItem.name
      : mondayItem.name;

  const translated = applyNameTranslations(baseName, mapping?.nameTranslations ?? {});
  return translated.trim() || mondayItem.name;
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

export async function syncMondayItemToJira(input: {
  boardId: string;
  itemId: string;
  keepSynced?: boolean;
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
      attachmentCount: 0
    };
  }

  const mondayItem = await getMondayItemForSync(itemId);
  const summary = resolveSummaryFromMapping(mondayItem, mapping);
  const assetsToSync = resolveAssetsFromMapping(mondayItem, mapping);
  let issueKey = existing?.issueKey;
  let created = false;

  if (!issueKey) {
    const createdIssue = await createJiraIssue({
      account: jiraAccount,
      projectKey: mapping.projectKey,
      summary,
      description: `Created from Monday board ${mondayItem.boardName} (ID: ${mondayItem.boardId}), item ID: ${mondayItem.id}.`
    });

    issueKey = createdIssue.key;
    created = true;
  } else {
    await updateJiraIssueSummary({
      account: jiraAccount,
      issueIdOrKey: issueKey,
      summary,
      description: `Updated from Monday board ${mondayItem.boardName} (ID: ${mondayItem.boardId}), item ID: ${mondayItem.id}.`
    });
  }

  let attachmentCount = 0;
  const alreadyUploadedAssetIds = new Set(existing?.uploadedAssetIds ?? []);
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

  await setSyncedItem({
    boardId,
    itemId,
    issueKey,
    uploadedAssetIds
  });

  return {
    issueKey,
    created,
    attachmentCount
  };
}
