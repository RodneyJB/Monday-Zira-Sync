import axios from "axios";
import ffmpegStatic from "ffmpeg-static";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  transitions: Array<{
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
  }>;
};

type JiraIssueLabelsResponse = {
  fields: {
    labels?: string[];
  };
};

const mondayStatusLabelPrefix = "monday-status-";
const MAX_JIRA_ATTACHMENT_SIZE_BYTES = 15 * 1024 * 1024;

export function shouldCompressAttachmentForUpload(fileName: string, fileSizeBytes: number): boolean {
  if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) {
    return false;
  }

  if (fileSizeBytes <= MAX_JIRA_ATTACHMENT_SIZE_BYTES) {
    return false;
  }

  const lowerName = fileName.toLowerCase();
  return lowerName.endsWith(".mov") || lowerName.endsWith(".mp4") || lowerName.endsWith(".m4v") || lowerName.endsWith(".avi");
}

export function shouldZipAttachmentForUpload(fileName: string, fileSizeBytes: number): boolean {
  if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) {
    return false;
  }

  if (fileSizeBytes <= MAX_JIRA_ATTACHMENT_SIZE_BYTES) {
    return false;
  }

  const lowerName = fileName.toLowerCase();
  return lowerName.endsWith(".mov") || lowerName.endsWith(".mp4") || lowerName.endsWith(".m4v") || lowerName.endsWith(".avi");
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

function buildJiraDescriptionDoc(description: string, mondayItemUrl?: string): {
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

export function buildMondayIssueLookupJql(input: {
  projectKey: string;
  labels: string[];
  boardId?: string;
  itemId?: string;
}): string {
  const escapedProject = input.projectKey.replace(/"/g, '\\"');
  const clauses = [`project = "${escapedProject}"`];

  const labels = input.labels.filter((label) => label.trim().length > 0);
  for (const label of labels) {
    clauses.push(`labels = "${label.replace(/"/g, '\\\"')}"`);
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
}): Promise<JiraIssueMatch | null> {
  const { account, projectKey, boardId, itemId } = input;
  const labels = input.labels.filter((label) => label.trim().length > 0);
  if (labels.length === 0 && !(boardId && itemId)) {
    return null;
  }

  const jql = buildMondayIssueLookupJql({
    projectKey,
    labels,
    boardId,
    itemId
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
  labels?: string[];
}): Promise<JiraCreatedIssue> {
  const { account, projectKey, summary, description, priorityName, mondayItemUrl, labels } = input;

  const url = new URL("/rest/api/3/issue", account.baseUrl);
  const buildPayload = (includePriority: boolean) => ({
    fields: {
      project: {
        key: projectKey
      },
      issuetype: {
        name: "Task"
      },
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
        mondayItemUrl
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
}): Promise<void> {
  const { account, issueIdOrKey, summary, description, priorityName, mondayItemUrl } = input;
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
        mondayItemUrl
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

function isMovFileName(fileName: string): boolean {
  return /\.mov$/i.test(fileName);
}

function crc32(buffer: Buffer): number {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[i] = value >>> 0;
  }

  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function createSingleFileZipArchive(fileName: string, fileData: Buffer): Buffer {
  const fileNameBuffer = Buffer.from(fileName, "utf8");
  const crc = crc32(fileData);
  const fileDataSize = fileData.length;
  const localHeader = Buffer.alloc(30 + fileNameBuffer.length);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0x0800, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(fileDataSize, 18);
  localHeader.writeUInt32LE(fileDataSize, 22);
  localHeader.writeUInt16LE(fileNameBuffer.length, 26);
  localHeader.writeUInt16LE(0, 28);
  fileNameBuffer.copy(localHeader, 30);

  const centralHeader = Buffer.alloc(46 + fileNameBuffer.length);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0x0800, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(fileDataSize, 20);
  centralHeader.writeUInt32LE(fileDataSize, 24);
  centralHeader.writeUInt16LE(fileNameBuffer.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);
  centralHeader.writeUInt32LE(0, 46);
  fileNameBuffer.copy(centralHeader, 46);

  const centralHeaderSize = centralHeader.length;
  const localHeaderSize = localHeader.length;
  const zipSize = localHeaderSize + fileDataSize + centralHeaderSize + 22;
  const buffer = Buffer.alloc(zipSize);

  localHeader.copy(buffer, 0);
  fileData.copy(buffer, localHeaderSize);
  centralHeader.copy(buffer, localHeaderSize + fileDataSize);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralHeaderSize, 12);
  eocd.writeUInt32LE(localHeaderSize + fileDataSize, 16);
  eocd.writeUInt16LE(0, 20);
  eocd.copy(buffer, localHeaderSize + fileDataSize + centralHeaderSize);

  return buffer;
}

async function compressToZipBuffer(fileData: Buffer, fileName: string): Promise<Buffer> {
  return createSingleFileZipArchive(fileName, fileData);
}

async function convertMovToMp4(inputBuffer: Buffer): Promise<Buffer> {
  const ffmpegPath = String(ffmpegStatic || "");
  if (!ffmpegPath) {
    throw new Error("ffmpeg is not available for MOV conversion.");
  }

  const inputPath = join(tmpdir(), `jira-mov-${Date.now()}-${Math.random().toString(16).slice(2)}.mov`);
  const outputPath = join(tmpdir(), `jira-mov-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`);

  await fs.writeFile(inputPath, inputBuffer);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      [
        "-y",
        "-i",
        inputPath,
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "28",
        "-maxrate",
        "1200k",
        "-bufsize",
        "2400k",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-movflags",
        "+faststart",
        "-fs",
        String(MAX_JIRA_ATTACHMENT_SIZE_BYTES),
        outputPath
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg conversion failed: ${stderr || "unknown error"}`));
      }
    });
  });

  try {
    const converted = await fs.readFile(outputPath);
    return Buffer.from(converted);
  } finally {
    await Promise.allSettled([
      fs.rm(inputPath, { force: true }),
      fs.rm(outputPath, { force: true })
    ]);
  }
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
    maxContentLength: MAX_JIRA_ATTACHMENT_SIZE_BYTES * 3,
    maxBodyLength: MAX_JIRA_ATTACHMENT_SIZE_BYTES * 3,
    validateStatus: (status) => status >= 200 && status < 300
  });

  let fileBytes: Buffer = Buffer.from(fileResponse.data as ArrayBuffer);
  let finalFileName = safeFileName;

  if (shouldCompressAttachmentForUpload(safeFileName, fileBytes.length)) {
    fileBytes = await convertMovToMp4(fileBytes);
    finalFileName = safeFileName.replace(/\.(mov|mp4|m4v|avi)$/i, ".mp4");
  }

  if (fileBytes.length > MAX_JIRA_ATTACHMENT_SIZE_BYTES && shouldZipAttachmentForUpload(finalFileName, fileBytes.length)) {
    const zipFileName = `${finalFileName.replace(/\.[^.]+$/i, "")}.zip`;
    const zipBuffer = Buffer.from(await compressToZipBuffer(fileBytes, finalFileName));
    fileBytes = zipBuffer;
    finalFileName = zipFileName;
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
    maxContentLength: MAX_JIRA_ATTACHMENT_SIZE_BYTES * 3,
    maxBodyLength: MAX_JIRA_ATTACHMENT_SIZE_BYTES * 3,
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

  const transitionsUrl = new URL(`/rest/api/3/issue/${input.issueIdOrKey}/transitions`, input.account.baseUrl);
  const transitionsResponse = await axios.get<JiraTransitionResponse>(transitionsUrl.toString(), {
    headers: jiraHeaders(input.account),
    timeout: 15000
  });

  const transitions = transitionsResponse.data.transitions ?? [];
  const normalizedTarget = normalizeStatus(statusLabel);
  const normalizedTargetComparable = normalizeComparable(statusLabel);
  const fallbackLabel = formatFallbackStatusLabel(statusLabel);

  // Keep a single visible label that mirrors the latest Monday status.
  await replaceMondayStatusLabel(
    input.account,
    input.issueIdOrKey,
    fallbackLabel,
    input.previousStatusLabel
  );

  const exact = transitions.find((transition) => normalizeStatus(transition.to.name) === normalizedTarget);
  if (exact) {
    await transitionIssue(input.account, input.issueIdOrKey, exact.id);
    return {
      action: "transitioned",
      details: `Transitioned to ${exact.to.name}; label set ${fallbackLabel}`,
      appliedLabel: fallbackLabel
    };
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
    await transitionIssue(input.account, input.issueIdOrKey, fuzzy.id);
    return {
      action: "transitioned",
      details: `Transitioned by fuzzy match to ${fuzzy.to.name}; label set ${fallbackLabel}`,
      appliedLabel: fallbackLabel
    };
  }

  const inferredCategory = inferStatusCategory(statusLabel);
  if (inferredCategory) {
    const byCategory = transitions.find(
      (transition) => normalizeStatus(transition.to.statusCategory.key) === inferredCategory
    );

    if (byCategory) {
      await transitionIssue(input.account, input.issueIdOrKey, byCategory.id);
      return {
        action: "transitioned",
        details: `Transitioned by category ${inferredCategory} to ${byCategory.to.name}; label set ${fallbackLabel}`,
        appliedLabel: fallbackLabel
      };
    }
  }

  return {
    action: "labeled",
    details: `No Jira status transition matched; set label ${fallbackLabel}`,
    appliedLabel: fallbackLabel
  };
}
