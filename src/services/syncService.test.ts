import test from "node:test";
import assert from "node:assert/strict";

import { extractAssetIdsFromFileColumnValue, shouldUploadAttachmentsForSync } from "./syncService.js";

test("extractAssetIdsFromFileColumnValue handles object payloads from Monday file columns", () => {
  const result = extractAssetIdsFromFileColumnValue({
    files: [
      { id: "file-1" },
      { assetId: "file-2" }
    ],
    value: [{ file_id: "file-3" }]
  });

  assert.deepEqual(result, ["file-1", "file-2", "file-3"]);
});

test("extractAssetIdsFromFileColumnValue handles JSON strings produced by Monday", () => {
  const result = extractAssetIdsFromFileColumnValue(JSON.stringify({
    files: [{ uuid: "abc-123" }],
    assets: [{ id: "def-456" }]
  }));

  assert.deepEqual(result, ["abc-123", "def-456"]);
});

test("shouldUploadAttachmentsForSync uploads file-column attachments after issue creation but not item-asset attachments", () => {
  assert.equal(
    shouldUploadAttachmentsForSync({ created: true, existingIssueKey: undefined, attachmentSource: "file_column" }),
    true
  );
  assert.equal(
    shouldUploadAttachmentsForSync({ created: true, existingIssueKey: undefined, attachmentSource: "item_assets" }),
    false
  );
  assert.equal(
    shouldUploadAttachmentsForSync({ created: false, existingIssueKey: "ABC-123", attachmentSource: "file_column" }),
    true
  );
  assert.equal(
    shouldUploadAttachmentsForSync({ created: false, existingIssueKey: undefined, attachmentSource: "file_column" }),
    false
  );
});
