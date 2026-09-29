import axios from "axios";

import type { JiraAccountConfig } from "../config.js";

export type JiraProject = {
  id: string;
  key: string;
  name: string;
};

export type JiraPriority = {
  id: string;
  name: string;
};

export type JiraCreatedIssue = {
  id: string;
  key: string;
  self: string;
};

export type JiraIssueMatch = {
  id: string;
  key: string;
};

type JiraDocNode = {
  type: string;
  text?: string;
  marks?: Array<{
    type: string;
    attrs: {
      href: string;
    };
  }>;
  content?: JiraDocNode[];
};

type JiraSearchResponse = {
  values?: Array<{
    id: string;
    key: string;
    name: string;
  }>;
  issues?: Array<{
    id: string;
    key: string;
    fields?: {
      description?: unknown;
    };
  }>;
};

type JiraPriorityResponse = Array<{
  id: string;
  name: string;
}>;

type JiraTransitionResponse = {
  transitions: JiraTransition[];
};

type JiraIssueLabelsResponse = {
  fields: {
    labels?: string[];
  };
};

type JiraTransition = {
  id: string;
  name: string;
  to: {
    id: string;
    name: string;
    statusCategory: {
      key: string;
      name: string;
    };
  };
};

const mondayStatusLabelPrefix = "monday-status-";
const MAX_JIRA_ATTACHMENT_SIZE_BYTES = 20 * 1024 * 1024;

export class JiraAttachmentSizeError extends Error {
  constructor(fileSizeBytes: number) {
    super(`Attachment exceeds ${(MAX_JIRA_ATTACHMENT_SIZE_BYTES / (1024 * 1024)).toFixed(0)}MB and must be linked in Jira description.`);
    this.name = "JiraAttachmentSizeError";
    this.message = `Attachment exceeds ${(MAX_JIRA_ATTACHMENT_SIZE_BYTES / (1024 * 1024)).toFixed(0)}MB and must be linked in Jira description.`;
  }
}

export function shouldLinkAttachmentInDescription(fileSizeBytes: number): boolean {
  return Number.isFinite(fileSizeBytes) && fileSizeBytes > MAX_JIRA_ATTACHMENT_SIZE_BYTES;
}

export function isLargeAttachmentError(error: unknown): boolean {
  if (error instanceof JiraAttachmentSizeError) {
    return true;
  }

  return error instanceof Error && /must be linked in Jira description/i.test(error.message);
}

export function buildMondayAssetUrl(
  mondayBaseUrl: string,
  boardId: string,
  itemId: string,
  assetId: string
): string {
  const base = mondayBaseUrl.replace(/\/$/, "");
  return `${base}/boards/${boardId}/pulses/${itemId}?asset_id=${assetId}`;
}

function normalizeStatus(status: string): string {
  return status.trim().toLowerCase();
}

function normalizeComparable(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function slugifyStatus(status: string): string {
  return status
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function formatFallbackStatusLabel(status: string): string {
  const slug = slugifyStatus(status);
  return slug || "status";
}

function inferStatusCategory(statusLabel: string): string | null {
  const status = normalizeStatus(statusLabel);

  if (/(done|closed|resolved|finish|complete)/i.test(status)) {
    return "done";
  }

  if (/(progress|working|doing|review|testing|qa|active)/i.test(status)) {
    return "indeterminate";
  }

  if (/(todo|to do|open|ready|backlog|new)/i.test(status)) {
    return "new";
  }

  // For domain-specific labels (OEM, parts/components, etc.), default to in-progress category.
  return "indeterminate";
}

function buildAuthHeader(account: JiraAccountConfig): string {
  const token = Buffer.from(`${account.email}:${account.apiToken}`).toString("base64");
  return `Basic ${token}`;
}

function jiraHeaders(account: JiraAccountConfig) {
  return {
    Authorization: buildAuthHeader(account),
    Accept: "application/json"
  };
}

export function buildJiraDescriptionDoc(
  description: string,
  mondayItemUrl?: string,
  attachmentFallbackLink?: { text: string; href: string }
): {
  type: string;
  version: number;
  content: JiraDocNode[];
} {
  const content: JiraDocNode[] = [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: description
        }
      ]
    }
  ];

  if (attachmentFallbackLink) {
    content.push({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: attachmentFallbackLink.text,
          marks: [
            {
              type: "link",
              attrs: {
                href: attachmentFallbackLink.href
              }
            }
          ]
        }
      ]
    });
  }

  if (mondayItemUrl) {
    content.push({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Open in Monday",
          marks: [
            {
              type: "link",
              attrs: {
                href: mondayItemUrl
              }
            }
          ]
        }
      ]
    });
  }

  return {
    type: "doc",
    version: 1,
    content
  };
}

export async function listJiraProjects(account: JiraAccountConfig): Promise<JiraProject[]> {
  const url = new URL("/rest/api/3/project/search", account.baseUrl);
  url.searchParams.set("maxResults", "100");

  const response = await axios.get<JiraSearchResponse>(url.toString(), {
    headers: jiraHeaders(account),
    timeout: 15000
  });

  return (response.data.values ?? []).map((project) => ({
    id: project.id,
    key: project.key,
    name: project.name
  }));
}

export async function listJiraIssues(
  account: JiraAccountConfig,
  projectKey: string,
  maxResults = 50
): Promise<Array<{ key: string; summary: string }>> {
  const url = new URL("/rest/api/3/search/jql", account.baseUrl);
  const jql = `project = "${projectKey.replace(/"/g, '\\"')}" ORDER BY updated DESC`;

  const response = await axios.post<{ issues?: Array<{ key?: string; fields?: { summary?: string } }> }>(
    url.toString(),
    {
      jql,
      maxResults,
      fields: ["summary"]
    },
    {
      headers: {
        ...jiraHeaders(account),
        "Content-Type": "application/json"
      },
      timeout: 15000
    }
  );

  return (response.data.issues ?? [])
    .filter((issue) => issue.key)
    .map((issue) => ({
      key: issue.key as string,
      summary: issue.fields?.summary || "Untitled issue"
    }));
}

export function buildMondayIssueLookupJql(input: {
  projectKey: string;
  labels: string[];
  boardId?: string;
  itemId?: string;
  parentIssueKey?: string;
}): string {
  const escapedProject = input.projectKey.replace(/"/g, '\\"');
  const clauses = [`project = "${escapedProject}"`];

  const labels = input.labels.filter((label) => label.trim().length > 0);
  for (const label of labels) {
    clauses.push(`labels = "${label.replace(/"/g, '\\\"')}"`);
  }

  if (input.parentIssueKey) {
    const escapedParent = input.parentIssueKey.replace(/"/g, '\\"');
    clauses.push(`parent = "${escapedParent}"`);
  }

  if (input.boardId && input.itemId) {
    const mondayUrlPath = `boards/${input.boardId}/pulses/${input.itemId}`;
    clauses.push(`description ~ "${mondayUrlPath}"`);
  }

  return `${clauses.join(" AND ")} ORDER BY created DESC`;
}

export async function findJiraIssueByLabels(input: {
  account: JiraAccountConfig;
  projectKey: string;
  labels: string[];
  boardId?: string;
  itemId?: string;
  parentIssueKey?: string;
}): Promise<JiraIssueMatch | null> {
  const { account, projectKey, boardId, itemId, parentIssueKey } = input;
  const labels = input.labels.filter((label) => label.trim().length > 0);
  if (labels.length === 0 && !(boardId && itemId) && !parentIssueKey) {
    return null;
  }

  const jql = buildMondayIssueLookupJql({
    projectKey,
    labels,
    boardId,
    itemId,
    parentIssueKey
  });

  const url = new URL("/rest/api/3/search/jql", account.baseUrl);

  const response = await axios.post<JiraSearchResponse>(
    url.toString(),
    {
      jql,
      maxResults: 1,
      fields: ["id", "key"]
    },
    {
      headers: {
        ...jiraHeaders(account),
        "Content-Type": "application/json"
      },
      timeout: 15000
    }
  );

  const match = response.data.issues?.[0];
  if (!match) {
    return null;
  }

  return {
    id: match.id,
    key: match.key
  };
}

export async function createJiraIssue(input: {
  account: JiraAccountConfig;
  projectKey: string;
  summary: string;
  description?: string;
  priorityName?: string;
  mondayItemUrl?: string;
  attachmentFallbackLink?: { text: string; href: string };
  labels?: string[];
  parentIssueKey?: string;
  issueTypeName?: string;
}): Promise<JiraCreatedIssue> {
  const {
    account,
    projectKey,
    summary,
    description,
    priorityName,
    mondayItemUrl,
    attachmentFallbackLink,
    labels,
    parentIssueKey,
    issueTypeName
  } = input;

  const url = new URL("/rest/api/3/issue", account.baseUrl);
  const resolvedIssueTypeName = issueTypeName ?? (parentIssueKey ? "Sub-task" : "Task");
  const buildPayload = (includePriority: boolean) => ({
    fields: {
      project: {
        key: projectKey
      },
      issuetype: {
        name: resolvedIssueTypeName
      },
      ...(parentIssueKey
        ? {
            parent: {
              key: parentIssueKey
            }
          }
        : {}),
      summary,
      ...(includePriority && priorityName
        ? {
            priority: {
              name: priorityName
            }
          }
        : {}),
      ...(labels && labels.length > 0 ? { labels } : {}),
      description: buildJiraDescriptionDoc(
        description ?? "Created automatically from Monday board item.",
        mondayItemUrl,
        attachmentFallbackLink
      )
    }
  });

  let response;
  try {
    response = await axios.post<JiraCreatedIssue>(url.toString(), buildPayload(true), {
      headers: {
        ...jiraHeaders(account),
        "Content-Type": "application/json"
      },
      timeout: 15000
    });
  } catch (error) {
    if (priorityName) {
      response = await axios.post<JiraCreatedIssue>(url.toString(), buildPayload(false), {
        headers: {
          ...jiraHeaders(account),
          "Content-Type": "application/json"
        },
        timeout: 15000
      });
    } else {
      throw error;
    }
  }

  return response.data;
}

export async function updateJiraIssueSummary(input: {
  account: JiraAccountConfig;
  issueIdOrKey: string;
  summary: string;
  description?: string;
  priorityName?: string;
  mondayItemUrl?: string;
  attachmentFallbackLink?: { text: string; href: string };
}): Promise<void> {
  const { account, issueIdOrKey, summary, description, priorityName, mondayItemUrl, attachmentFallbackLink } = input;
  const url = new URL(`/rest/api/3/issue/${issueIdOrKey}`, account.baseUrl);

  const buildPayload = (includePriority: boolean) => ({
    fields: {
      summary,
      ...(includePriority && priorityName
        ? {
            priority: {
              name: priorityName
            }
          }
        : {}),
      description: buildJiraDescriptionDoc(
        description ?? "Updated automatically from Monday board item.",
        mondayItemUrl,
        attachmentFallbackLink
      )
    }
  });

  try {
    await axios.put(url.toString(), buildPayload(true), {
      headers: {
        ...jiraHeaders(account),
        "Content-Type": "application/json"
      },
      timeout: 15000
    });
  } catch (error) {
    if (priorityName) {
      await axios.put(url.toString(), buildPayload(false), {
        headers: {
          ...jiraHeaders(account),
          "Content-Type": "application/json"
        },
        timeout: 15000
      });
      return;
    }

    throw error;
  }
}

export async function listJiraPriorities(account: JiraAccountConfig): Promise<JiraPriority[]> {
  const url = new URL("/rest/api/3/priority", account.baseUrl);

  const response = await axios.get<JiraPriorityResponse>(url.toString(), {
    headers: jiraHeaders(account),
    timeout: 15000
  });

  return response.data.map((entry) => ({
    id: entry.id,
    name: entry.name
  }));
}

export function normalizeAttachmentDownloadUrl(fileUrl: string): string | null {
  if (!fileUrl || typeof fileUrl !== "string") {
    return null;
  }

  try {
    const url = new URL(fileUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

export function sanitizeAttachmentFileName(fileName: string): string {
  const baseName = (fileName || "attachment.bin")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();

  return baseName.length > 0 ? baseName : "attachment.bin";
}

function looksLikeHtmlPayload(fileBytes: Buffer): boolean {
  const probe = fileBytes.subarray(0, Math.min(fileBytes.length, 512)).toString("utf8").trimStart().toLowerCase();
  return probe.startsWith("<!doctype html") || probe.startsWith("<html");
}

export async function uploadJiraAttachmentFromUrl(input: {
  account: JiraAccountConfig;
  issueIdOrKey: string;
  fileUrl: string;
  fileName: string;
}): Promise<void> {
  const { account, issueIdOrKey, fileUrl, fileName } = input;
  const safeUrl = normalizeAttachmentDownloadUrl(fileUrl);

  if (!safeUrl) {
    throw new Error("Attachment URL is missing or not a valid http(s) URL.");
  }

  const safeFileName = sanitizeAttachmentFileName(fileName);
  const uploadUrl = new URL(`/rest/api/3/issue/${issueIdOrKey}/attachments`, account.baseUrl);

  const fileResponse = await axios.get(safeUrl, {
    responseType: "arraybuffer",
    timeout: 30000,
    maxContentLength: 50 * 1024 * 1024,
    maxBodyLength: 50 * 1024 * 1024,
    validateStatus: (status) => status >= 200 && status < 300
  });

  const fileBytes: Buffer = Buffer.from(fileResponse.data as ArrayBuffer);
  const finalFileName = safeFileName;
  const contentType = String(fileResponse.headers["content-type"] || "").toLowerCase();

  if (contentType.includes("text/html") || looksLikeHtmlPayload(fileBytes)) {
    throw new Error(`Attachment URL returned HTML instead of a downloadable file: ${safeUrl}`);
  }

  if (shouldLinkAttachmentInDescription(fileBytes.length)) {
    throw new JiraAttachmentSizeError(fileBytes.length);
  }

  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(fileBytes)]), finalFileName);

  await axios.post(uploadUrl.toString(), formData, {
    headers: {
      Authorization: buildAuthHeader(account),
      Accept: "application/json",
      "X-Atlassian-Token": "no-check"
    },
    timeout: 60000,
    maxContentLength: 50 * 1024 * 1024,
    maxBodyLength: 50 * 1024 * 1024,
    validateStatus: (status) => status >= 200 && status < 300
  });
}

async function transitionIssue(account: JiraAccountConfig, issueIdOrKey: string, transitionId: string): Promise<void> {
  const url = new URL(`/rest/api/3/issue/${issueIdOrKey}/transitions`, account.baseUrl);

  await axios.post(
    url.toString(),
    {
      transition: {
        id: transitionId
      }
    },
    {
      headers: {
        ...jiraHeaders(account),
        "Content-Type": "application/json"
      },
      timeout: 15000
    }
  );
}

async function replaceMondayStatusLabel(
  account: JiraAccountConfig,
  issueIdOrKey: string,
  nextLabel: string,
  previousLabel?: string
): Promise<void> {
  const issueUrl = new URL(`/rest/api/3/issue/${issueIdOrKey}`, account.baseUrl);
  issueUrl.searchParams.set("fields", "labels");

  const issueResponse = await axios.get<JiraIssueLabelsResponse>(issueUrl.toString(), {
    headers: jiraHeaders(account),
    timeout: 15000
  });

  const existingLabels = issueResponse.data.fields.labels ?? [];
  const preservedLabels = existingLabels.filter((label) => {
    if (label.startsWith(mondayStatusLabelPrefix)) {
      return false;
    }

    if (previousLabel && label === previousLabel) {
      return false;
    }

    return true;
  });
  const finalLabels = [...new Set([...preservedLabels, nextLabel])];

  const updateUrl = new URL(`/rest/api/3/issue/${issueIdOrKey}`, account.baseUrl);
  await axios.put(
    updateUrl.toString(),
    {
      fields: {
        labels: finalLabels
      }
    },
    {
      headers: {
        ...jiraHeaders(account),
        "Content-Type": "application/json"
      },
      timeout: 15000
    }
  );
}

export async function applyJiraStatusFromMonday(input: {
  account: JiraAccountConfig;
  issueIdOrKey: string;
  statusLabel: string;
  previousStatusLabel?: string;
}): Promise<{ action: "transitioned" | "labeled" | "skipped"; details: string; appliedLabel?: string }> {
  const statusLabel = input.statusLabel.trim();
  if (!statusLabel) {
    return { action: "skipped", details: "No status label available" };
  }

  const fallbackLabel = formatFallbackStatusLabel(statusLabel);

  try {
    await replaceMondayStatusLabel(
      input.account,
      input.issueIdOrKey,
      fallbackLabel,
      input.previousStatusLabel
    );
  } catch (error) {
    console.warn("Could not mirror Monday status as Jira label; proceeding with best-effort sync.", {
      issueIdOrKey: input.issueIdOrKey,
      statusLabel,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  let transitions: JiraTransition[] = [];
  try {
    const transitionsUrl = new URL(`/rest/api/3/issue/${input.issueIdOrKey}/transitions`, input.account.baseUrl);
    const transitionsResponse = await axios.get<JiraTransitionResponse>(transitionsUrl.toString(), {
      headers: jiraHeaders(input.account),
      timeout: 15000
    });
    transitions = transitionsResponse.data.transitions ?? [];
  } catch (error) {
    return {
      action: "labeled",
      details: `Could not read Jira transitions; status label set ${fallbackLabel}. Reason: ${error instanceof Error ? error.message : String(error)}`,
      appliedLabel: fallbackLabel
    };
  }

  const normalizedTarget = normalizeStatus(statusLabel);
  const normalizedTargetComparable = normalizeComparable(statusLabel);

  const exact = transitions.find((transition) => normalizeStatus(transition.to.name) === normalizedTarget);
  if (exact) {
    try {
      await transitionIssue(input.account, input.issueIdOrKey, exact.id);
      return {
        action: "transitioned",
        details: `Transitioned to ${exact.to.name}; label set ${fallbackLabel}`,
        appliedLabel: fallbackLabel
      };
    } catch (error) {
      console.warn("Jira status transition rejected; keeping label-only sync.", {
        issueIdOrKey: input.issueIdOrKey,
        statusLabel,
        transitionId: exact.id,
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        action: "labeled",
        details: `Transition to ${exact.to.name} was rejected; status label set ${fallbackLabel}`,
        appliedLabel: fallbackLabel
      };
    }
  }

  const fuzzy = transitions.find((transition) => {
    const transitionComparable = normalizeComparable(transition.to.name);
    return (
      transitionComparable === normalizedTargetComparable ||
      transitionComparable.includes(normalizedTargetComparable) ||
      normalizedTargetComparable.includes(transitionComparable)
    );
  });

  if (fuzzy) {
    try {
      await transitionIssue(input.account, input.issueIdOrKey, fuzzy.id);
      return {
        action: "transitioned",
        details: `Transitioned by fuzzy match to ${fuzzy.to.name}; label set ${fallbackLabel}`,
        appliedLabel: fallbackLabel
      };
    } catch (error) {
      console.warn("Jira fuzzy transition rejected; keeping label-only sync.", {
        issueIdOrKey: input.issueIdOrKey,
        statusLabel,
        transitionId: fuzzy.id,
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        action: "labeled",
        details: `Transition by fuzzy match to ${fuzzy.to.name} was rejected; status label set ${fallbackLabel}`,
        appliedLabel: fallbackLabel
      };
    }
  }

  const inferredCategory = inferStatusCategory(statusLabel);
  if (inferredCategory) {
    const byCategory = transitions.find(
      (transition) => normalizeStatus(transition.to.statusCategory.key) === inferredCategory
    );

    if (byCategory) {
      try {
        await transitionIssue(input.account, input.issueIdOrKey, byCategory.id);
        return {
          action: "transitioned",
          details: `Transitioned by category ${inferredCategory} to ${byCategory.to.name}; label set ${fallbackLabel}`,
          appliedLabel: fallbackLabel
        };
      } catch (error) {
        console.warn("Jira category transition rejected; keeping label-only sync.", {
          issueIdOrKey: input.issueIdOrKey,
          statusLabel,
          transitionId: byCategory.id,
          error: error instanceof Error ? error.message : String(error)
        });
        return {
          action: "labeled",
          details: `Transition by category ${inferredCategory} to ${byCategory.to.name} was rejected; status label set ${fallbackLabel}`,
          appliedLabel: fallbackLabel
        };
      }
    }
  }

  return {
    action: "labeled",
    details: `No Jira status transition matched; set label ${fallbackLabel}`,
    appliedLabel: fallbackLabel
  };
}
