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

type JiraSearchResponse = {
  values: Array<{
    id: string;
    key: string;
    name: string;
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

function normalizeStatus(status: string): string {
  return status.trim().toLowerCase();
}

function slugifyStatus(status: string): string {
  return status
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
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

  return null;
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

export async function listJiraProjects(account: JiraAccountConfig): Promise<JiraProject[]> {
  const url = new URL("/rest/api/3/project/search", account.baseUrl);
  url.searchParams.set("maxResults", "100");

  const response = await axios.get<JiraSearchResponse>(url.toString(), {
    headers: jiraHeaders(account),
    timeout: 15000
  });

  return response.data.values.map((project) => ({
    id: project.id,
    key: project.key,
    name: project.name
  }));
}

export async function createJiraIssue(input: {
  account: JiraAccountConfig;
  projectKey: string;
  summary: string;
  description?: string;
  priorityName?: string;
}): Promise<JiraCreatedIssue> {
  const { account, projectKey, summary, description, priorityName } = input;

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
      description: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: description ?? "Created automatically from Monday board item."
              }
            ]
          }
        ]
      }
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
}): Promise<void> {
  const { account, issueIdOrKey, summary, description, priorityName } = input;
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
      description: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: description ?? "Updated automatically from Monday board item."
              }
            ]
          }
        ]
      }
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

export async function uploadJiraAttachmentFromUrl(input: {
  account: JiraAccountConfig;
  issueIdOrKey: string;
  fileUrl: string;
  fileName: string;
}): Promise<void> {
  const { account, issueIdOrKey, fileUrl, fileName } = input;

  const fileResponse = await fetch(fileUrl);
  if (!fileResponse.ok) {
    throw new Error(`Could not download file from Monday (${fileResponse.status}).`);
  }

  const fileBytes = await fileResponse.arrayBuffer();
  const form = new FormData();
  form.append("file", new Blob([fileBytes]), fileName);

  const uploadUrl = new URL(`/rest/api/3/issue/${issueIdOrKey}/attachments`, account.baseUrl);
  const uploadResponse = await fetch(uploadUrl.toString(), {
    method: "POST",
    headers: {
      Authorization: buildAuthHeader(account),
      Accept: "application/json",
      "X-Atlassian-Token": "no-check"
    },
    body: form
  });

  if (!uploadResponse.ok) {
    const responseText = await uploadResponse.text();
    throw new Error(`Jira attachment upload failed (${uploadResponse.status}): ${responseText}`);
  }
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
  nextLabel: string
): Promise<void> {
  const issueUrl = new URL(`/rest/api/3/issue/${issueIdOrKey}`, account.baseUrl);
  issueUrl.searchParams.set("fields", "labels");

  const issueResponse = await axios.get<JiraIssueLabelsResponse>(issueUrl.toString(), {
    headers: jiraHeaders(account),
    timeout: 15000
  });

  const existingLabels = issueResponse.data.fields.labels ?? [];
  const preservedLabels = existingLabels.filter((label) => !label.startsWith(mondayStatusLabelPrefix));
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
}): Promise<{ action: "transitioned" | "labeled" | "skipped"; details: string }> {
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

  const exact = transitions.find((transition) => normalizeStatus(transition.to.name) === normalizedTarget);
  if (exact) {
    await transitionIssue(input.account, input.issueIdOrKey, exact.id);
    return { action: "transitioned", details: `Transitioned to ${exact.to.name}` };
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
        details: `Transitioned by category ${inferredCategory} to ${byCategory.to.name}`
      };
    }
  }

  const fallbackLabel = `${mondayStatusLabelPrefix}${slugifyStatus(statusLabel)}`;
  await replaceMondayStatusLabel(input.account, input.issueIdOrKey, fallbackLabel);
  return {
    action: "labeled",
    details: `No Jira status transition matched; set label ${fallbackLabel}`
  };
}
