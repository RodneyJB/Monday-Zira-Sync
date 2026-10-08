import assert from "node:assert/strict";
import test from "node:test";

import {
  buildJiraDescriptionDoc,
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

test("buildMondayIssueLookupJql can scope item lookups to a board parent issue", () => {
  const jql = buildMondayIssueLookupJql({
    projectKey: "DF",
    boardId: "1070",
    itemId: "456",
    parentIssueKey: "DF-42",
    labels: ["monday-board-1070", "monday-item-456"]
  });

  assert.match(jql, /project\s*=\s*"DF"/i);
  assert.match(jql, /parent\s*=\s*"DF-42"/i);
  assert.match(jql, /labels\s*=\s*"monday-item-456"/i);
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

  const doc = buildJiraDescriptionDoc(
    "Updated from Monday board 1500#005 XC (NB)",
    "https://mycompany.monday.com/boards/5100981950/pulses/123456789",
    { text: "Monday file", href: "https://mycompany.monday.com/boards/5100981950/pulses/123456789?asset_id=asset-42" }
  );

  const fallbackParagraph = doc.content[1];
  const fallbackText = fallbackParagraph?.content?.[0];

  assert.equal(fallbackText?.text, "Monday file");
  assert.equal(fallbackText?.marks?.[0]?.attrs.href, "https://mycompany.monday.com/boards/5100981950/pulses/123456789?asset_id=asset-42");
});

test("createJiraIssue retries rejected labels while preserving the Monday backlink", async (t) => {
  const { default: axios } = await import("axios");
  const { createJiraIssue } = await import("./jiraService.js");
  const payloads: Array<{ fields: { labels?: string[]; description: unknown } }> = [];
  t.mock.method(axios, "post", async (_url: string, payload: typeof payloads[number]) => {
    payloads.push(payload);
    if (payloads.length === 1) {
      throw { response: { status: 400, data: { errors: {
        labels: "Field 'labels' cannot be set. It is not on the appropriate screen, or unknown."
      } } } };
    }
    return { data: { id: "1", key: "DF-99", self: "https://example.atlassian.net/issue/1" } };
  });
  const result = await createJiraIssue({
    account: { id: "test", name: "Test", baseUrl: "https://example.atlassian.net", email: "test@example.com", apiToken: "test" },
    projectKey: "DF", summary: "Monday test", labels: ["monday-item-123"],
    mondayItemUrl: "https://example.monday.com/boards/456/pulses/123"
  });
  assert.equal(result.key, "DF-99");
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[0].fields.labels, ["monday-item-123"]);
  assert.equal(payloads[1].fields.labels, undefined);
  assert.match(JSON.stringify(payloads[1].fields.description), /boards\/456\/pulses\/123/);
});

test("createJiraIssue does not retry an ambiguous server failure", async (t) => {
  const { default: axios } = await import("axios");
  const { createJiraIssue } = await import("./jiraService.js");
  let calls = 0;
  t.mock.method(axios, "post", async () => {
    calls++;
    throw { response: { status: 500 } };
  });
  await assert.rejects(createJiraIssue({
    account: { id: "test", name: "Test", baseUrl: "https://example.atlassian.net", email: "test@example.com", apiToken: "test" },
    projectKey: "DF", summary: "Monday test", priorityName: "High"
  }));
  assert.equal(calls, 1);
});
test("createJiraIssue waits and retries an explicit Jira 429 response", async (t) => {
  const { default: axios } = await import("axios");
  const { createJiraIssue } = await import("./jiraService.js");
  let calls = 0;
  const started = Date.now();
  t.mock.method(axios, "post", async () => {
    calls++;
    if (calls === 1) throw { response: { status: 429, headers: { "retry-after": "1" } } };
    return { data: { id: "1", key: "DF-99", self: "https://example.atlassian.net/issue/1" } };
  });
  const result = await createJiraIssue({
    account: { id: "test", name: "Test", baseUrl: "https://example.atlassian.net", email: "test@example.com", apiToken: "test" },
    projectKey: "DF", summary: "Rate limit test"
  });
  assert.equal(result.key, "DF-99");
  assert.equal(calls, 2);
  assert.ok(Date.now() - started >= 990);
});

test("Sync Jira command does not send label or workflow requests", async (t) => {
  const { default: axios } = await import("axios");
  const { applyJiraStatusFromMonday } = await import("./jiraService.js");
  t.mock.method(axios, "get", () => { assert.fail("Unexpected Jira status request"); });
  t.mock.method(axios, "put", () => { assert.fail("Unexpected Jira label update"); });
  const result = await applyJiraStatusFromMonday({
    account: { id: "test", name: "Test", baseUrl: "https://example.atlassian.net", email: "test@example.com", apiToken: "test" },
    issueIdOrKey: "DF-99", statusLabel: "Sync Jira"
  });
  assert.equal(result.action, "skipped");
});