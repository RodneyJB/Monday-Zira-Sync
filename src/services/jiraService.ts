import axios from "axios";

import type { JiraAccountConfig } from "../config.js";

export type JiraProject = {
  id: string;
  key: string;
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
}): Promise<JiraCreatedIssue> {
  const { account, projectKey, summary, description } = input;

  const url = new URL("/rest/api/3/issue", account.baseUrl);
  const response = await axios.post<JiraCreatedIssue>(
    url.toString(),
    {
      fields: {
        project: {
          key: projectKey
        },
        issuetype: {
          name: "Task"
        },
        summary,
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
    },
    {
      headers: {
        ...jiraHeaders(account),
        "Content-Type": "application/json"
      },
      timeout: 15000
    }
  );

  return response.data;
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
