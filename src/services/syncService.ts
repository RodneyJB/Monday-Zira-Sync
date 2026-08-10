import { config } from "../config.js";
import { createJiraIssue, uploadJiraAttachmentFromUrl } from "./jiraService.js";
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
}): Promise<SyncResult> {
  const { boardId, itemId } = input;

  const mapping = await getBoardMapping(boardId);
  if (!mapping) {
    throw new Error("No Jira mapping configured for this board.");
  }

  const jiraAccount = config.jiraAccounts.find((account) => account.id === mapping.accountId);
  if (!jiraAccount) {
    throw new Error("Mapped Jira account not found in configuration.");
  }

  const existing = await getSyncedItem(boardId, itemId);
  if (existing) {
    return {
      issueKey: existing.issueKey,
      created: false,
      attachmentCount: 0
    };
  }

  const mondayItem = await getMondayItemForSync(itemId);
  const createdIssue = await createJiraIssue({
    account: jiraAccount,
    projectKey: mapping.projectKey,
    summary: mondayItem.name,
    description: `Created from Monday board ${mondayItem.boardName} (ID: ${mondayItem.boardId}), item ID: ${mondayItem.id}.`
  });

  let attachmentCount = 0;
  for (const asset of mondayItem.assets) {
    if (!asset.publicUrl) {
      continue;
    }

    const fileName = asset.name?.trim() || `asset-${asset.id}.${asset.fileExtension || "bin"}`;

    await uploadJiraAttachmentFromUrl({
      account: jiraAccount,
      issueIdOrKey: createdIssue.key,
      fileUrl: asset.publicUrl,
      fileName
    });

    attachmentCount += 1;
  }

  await setSyncedItem({
    boardId,
    itemId,
    issueKey: createdIssue.key
  });

  return {
    issueKey: createdIssue.key,
    created: true,
    attachmentCount
  };
}
