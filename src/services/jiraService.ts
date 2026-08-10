import axios from "axios";

import type { JiraAccountConfig } from "../config.js";

export type JiraProject = {
  id: string;
  key: string;
  name: string;
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

export async function listJiraProjects(account: JiraAccountConfig): Promise<JiraProject[]> {
  const url = new URL("/rest/api/3/project/search", account.baseUrl);
  url.searchParams.set("maxResults", "100");

  const response = await axios.get<JiraSearchResponse>(url.toString(), {
    headers: {
      Authorization: buildAuthHeader(account),
      Accept: "application/json"
    },
    timeout: 15000
  });

  return response.data.values.map((project) => ({
    id: project.id,
    key: project.key,
    name: project.name
  }));
}
