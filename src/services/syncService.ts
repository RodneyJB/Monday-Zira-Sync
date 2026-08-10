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
  let issueKey = existing?.issueKey;
  let created = false;

  if (!issueKey) {
    const createdIssue = await createJiraIssue({
      account: jiraAccount,
      projectKey: mapping.projectKey,
      summary: mondayItem.name,
      description: `Created from Monday board ${mondayItem.boardName} (ID: ${mondayItem.boardId}), item ID: ${mondayItem.id}.`
    });

    issueKey = createdIssue.key;
    created = true;
  } else {
    await updateJiraIssueSummary({
      account: jiraAccount,
      issueIdOrKey: issueKey,
      summary: mondayItem.name,
      description: `Updated from Monday board ${mondayItem.boardName} (ID: ${mondayItem.boardId}), item ID: ${mondayItem.id}.`
    });
  }

  let attachmentCount = 0;
  const alreadyUploadedAssetIds = new Set(existing?.uploadedAssetIds ?? []);
  const uploadedAssetIds = [...alreadyUploadedAssetIds];

  for (const asset of mondayItem.assets) {
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
