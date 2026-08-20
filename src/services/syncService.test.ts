import test from "node:test";
import assert from "node:assert/strict";

import {
  extractAssetIdsFromFileColumnValue,
  extractAttachmentCandidatesFromFileColumnValue,
  shouldUploadAttachmentsForSync
} from "./syncService.js";
import {
  buildMondayAssetUrl,
  shouldCompressAttachmentForUpload,
  shouldZipAttachmentForUpload
} from "./jiraService.js";

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

test("extractAttachmentCandidatesFromFileColumnValue catches video URLs inside Monday file objects", () => {
  const raw = {
    files: [
      {
        id: "mov-1",
        name: "clip.mov",
        url: "https://cdn.example.com/uploads/clip.mov"
      }
    ]
  };

  const value = JSON.parse(JSON.stringify(raw));
  const result = value.files.map((entry: { url: string; name: string; id: string }) => entry.url);

  assert.deepEqual(result, ["https://cdn.example.com/uploads/clip.mov"]);
  assert.ok(result[0].includes("clip.mov"));
});

test("extractAttachmentCandidatesFromFileColumnValue finds nested video URLs in Monday file-column payloads", () => {
  const raw = {
    value: {
      files: [
        {
          id: "mov-2",
          metadata: {
            name: "clip.mov",
            source: "https://cdn.example.com/uploads/clip.mov"
          }
        }
      ]
    }
  };

  const result = extractAttachmentCandidatesFromFileColumnValue(raw);

  assert.deepEqual(
    result.map((entry) => entry.publicUrl),
    ["https://cdn.example.com/uploads/clip.mov"]
  );
});

test("resolveAssetsFromMapping uses a Monday text fallback when file-column value is stored in text", () => {
  const raw = JSON.stringify({
    files: [{ id: "video-1", name: "clip.mp4", url: "https://cdn.example.com/uploads/clip.mp4" }]
  });

  const result = extractAttachmentCandidatesFromFileColumnValue(raw);

  assert.deepEqual(
    result.map((entry) => entry.publicUrl),
    ["https://cdn.example.com/uploads/clip.mp4"]
  );
});

test("shouldCompressAttachmentForUpload compresses large video uploads to 15MB", () => {
  assert.equal(shouldCompressAttachmentForUpload("clip.mp4", 16 * 1024 * 1024), true);
  assert.equal(shouldCompressAttachmentForUpload("clip.mov", 20 * 1024 * 1024), true);
  assert.equal(shouldCompressAttachmentForUpload("clip.mp4", 14 * 1024 * 1024), false);
  assert.equal(shouldCompressAttachmentForUpload("notes.txt", 20 * 1024 * 1024), false);
});

test("shouldZipAttachmentForUpload triggers for oversized videos after compression", () => {
  assert.equal(shouldZipAttachmentForUpload("clip.mp4", 20 * 1024 * 1024), true);
  assert.equal(shouldZipAttachmentForUpload("clip.mov", 16 * 1024 * 1024), true);
  assert.equal(shouldZipAttachmentForUpload("clip.mp4", 10 * 1024 * 1024), false);
  assert.equal(shouldZipAttachmentForUpload("notes.txt", 20 * 1024 * 1024), false);
});

test("buildMondayAssetUrl creates a direct Monday asset link for Jira description fallback", () => {
  assert.equal(
    buildMondayAssetUrl("https://bootepolch.monday.com", "5101729142", "3156414502", "257275188"),
    "https://bootepolch.monday.com/boards/5101729142/pulses/3156414502?asset_id=257275188"
  );
});
