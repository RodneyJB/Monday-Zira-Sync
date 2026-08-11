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
