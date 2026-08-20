import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMondayAssetUrl,
  buildMondayIssueLookupJql,
  shouldLinkAttachmentInDescription
} from "./jiraService.js";
import { normalizeLanguage } from "./translationService.js";

test("buildMondayIssueLookupJql includes both labels and Monday item URL fallback", () => {
  const jql = buildMondayIssueLookupJql({
    projectKey: "BIXN",
    boardId: "5100981950",
    itemId: "123456789",
    labels: ["monday-board-5100981950", "monday-item-123456789"]
  });

  assert.match(jql, /project\s*=\s*"BIXN"/i);
  assert.match(jql, /labels\s*=\s*"monday-board-5100981950"/i);
  assert.match(jql, /labels\s*=\s*"monday-item-123456789"/i);
  assert.match(jql, /description\s*~\s*".*boards\/5100981950\/pulses\/123456789"/i);
});

test("normalizeLanguage accepts common display names like Spain and Spanish", () => {
  assert.equal(normalizeLanguage("Spain"), "es");
  assert.equal(normalizeLanguage("Spanish"), "es");
  assert.equal(normalizeLanguage("French"), "fr");
  assert.equal(normalizeLanguage("German"), "de");
  assert.equal(normalizeLanguage("English"), "en");
});

test("large attachments should be linked in the Jira description instead of compressed", () => {
  assert.equal(shouldLinkAttachmentInDescription(21 * 1024 * 1024), true);
  assert.equal(shouldLinkAttachmentInDescription(20 * 1024 * 1024), false);
  assert.equal(
    buildMondayAssetUrl("https://mycompany.monday.com", "5100981950", "123456789", "asset-42"),
    "https://mycompany.monday.com/boards/5100981950/pulses/123456789?asset_id=asset-42"
  );
});
