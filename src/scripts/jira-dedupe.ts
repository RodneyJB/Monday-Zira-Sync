import "dotenv/config";

type JiraAccount = {
  id: string;
  name: string;
  baseUrl: string;
  email: string;
  apiToken: string;
};

type JiraIssue = {
  id: string;
  key: string;
  fields: {
    summary?: string;
    created?: string;
    description?: unknown;
  };
};

type JiraSearchResponse = {
  issues: JiraIssue[];
  total: number;
  startAt: number;
  maxResults: number;
};

type Args = {
  accountId: string;
  projectKey: string;
  apply: boolean;
  delete: boolean;
  keep: "oldest" | "newest";
  limit?: number;
};

function parseJiraAccounts(raw: string | undefined): JiraAccount[] {
  if (!raw) {
    throw new Error("JIRA_ACCOUNTS_JSON is required.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("JIRA_ACCOUNTS_JSON must be valid JSON.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("JIRA_ACCOUNTS_JSON must be a JSON array.");
  }

  return parsed.map((entry) => {
    const candidate = entry as Record<string, unknown>;

    const account: JiraAccount = {
      id: String(candidate.id ?? ""),
      name: String(candidate.name ?? ""),
      baseUrl: String(candidate.baseUrl ?? ""),
      email: String(candidate.email ?? ""),
      apiToken: String(candidate.apiToken ?? "")
    };

    if (!account.id || !account.baseUrl || !account.email || !account.apiToken) {
      throw new Error("Each Jira account in JIRA_ACCOUNTS_JSON must include id, baseUrl, email, apiToken.");
    }

    return account;
  });
}

function parseArgs(argv: string[]): Args {
  const getValue = (name: string): string | undefined => {
    const index = argv.findIndex((arg) => arg === name);
    if (index < 0 || index + 1 >= argv.length) {
      return undefined;
    }

    return argv[index + 1];
  };

  const accountId = getValue("--account");
  const projectKey = getValue("--project");
  const keep = (getValue("--keep") ?? "oldest").toLowerCase();
  const limitRaw = getValue("--limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

  if (!accountId) {
    throw new Error("Missing --account <jiraAccountId>");
  }

  if (!projectKey) {
    throw new Error("Missing --project <jiraProjectKey>");
  }

  if (keep !== "oldest" && keep !== "newest") {
    throw new Error("--keep must be either oldest or newest");
  }

  if (limitRaw && (!Number.isFinite(limit) || (limit ?? 0) < 1)) {
    throw new Error("--limit must be a positive integer");
  }

  const apply = argv.includes("--apply");
  const del = argv.includes("--delete");

  return {
    accountId,
    projectKey,
    apply,
    delete: del,
    keep: keep as "oldest" | "newest",
    limit
  };
}

function buildAuthHeader(account: JiraAccount): string {
  const token = Buffer.from(`${account.email}:${account.apiToken}`).toString("base64");
  return `Basic ${token}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function extractMondayUrlsFromAdf(node: unknown, output: Set<string>): void {
  const record = asRecord(node);
  if (!record) {
    return;
  }

  const marks = Array.isArray(record.marks) ? record.marks : [];
  for (const mark of marks) {
    const markRecord = asRecord(mark);
    if (!markRecord || markRecord.type !== "link") {
      continue;
    }

    const attrs = asRecord(markRecord.attrs);
    const href = attrs?.href;
    if (typeof href === "string" && href.includes("monday.com") && href.includes("/boards/")) {
      output.add(href);
    }
  }

  const content = Array.isArray(record.content) ? record.content : [];
  for (const child of content) {
    extractMondayUrlsFromAdf(child, output);
  }
}

function pickIssueToKeep(issues: JiraIssue[], keep: "oldest" | "newest"): JiraIssue {
  const withCreated = [...issues].sort((a, b) => {
    const aDate = Date.parse(a.fields.created ?? "");
    const bDate = Date.parse(b.fields.created ?? "");

    if (Number.isNaN(aDate) && Number.isNaN(bDate)) {
      return a.key.localeCompare(b.key);
    }

    if (Number.isNaN(aDate)) {
      return 1;
    }

    if (Number.isNaN(bDate)) {
      return -1;
    }

    return aDate - bDate;
  });

  return keep === "newest" ? withCreated[withCreated.length - 1] : withCreated[0];
}

async function jiraRequest<T>(input: {
  account: JiraAccount;
  path: string;
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
}): Promise<T> {
  const url = new URL(input.path, input.account.baseUrl).toString();
  const response = await fetch(url, {
    method: input.method ?? "GET",
    headers: {
      Authorization: buildAuthHeader(input.account),
      Accept: "application/json",
      ...(input.body ? { "Content-Type": "application/json" } : {})
    },
    body: input.body ? JSON.stringify(input.body) : undefined
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Jira API ${input.method ?? "GET"} ${input.path} failed (${response.status}): ${details}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function fetchAllProjectIssues(account: JiraAccount, projectKey: string): Promise<JiraIssue[]> {
  const pageSize = 100;
  let startAt = 0;
  let total = Number.POSITIVE_INFINITY;
  const issues: JiraIssue[] = [];

  while (startAt < total) {
    const page = await jiraRequest<JiraSearchResponse>({
      account,
      path: "/rest/api/3/search",
      method: "POST",
      body: {
        jql: `project = ${projectKey} ORDER BY created ASC`,
        startAt,
        maxResults: pageSize,
        fields: ["summary", "description", "created"]
      }
    });

    issues.push(...page.issues);
    total = page.total;
    startAt += page.maxResults;
  }

  return issues;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const accounts = parseJiraAccounts(process.env.JIRA_ACCOUNTS_JSON);
  const account = accounts.find((entry) => entry.id === args.accountId);

  if (!account) {
    throw new Error(`Jira account '${args.accountId}' not found in JIRA_ACCOUNTS_JSON.`);
  }

  const issues = await fetchAllProjectIssues(account, args.projectKey);
  const grouped = new Map<string, JiraIssue[]>();

  for (const issue of issues) {
    const urls = new Set<string>();
    extractMondayUrlsFromAdf(issue.fields.description, urls);

    for (const url of urls) {
      const collection = grouped.get(url) ?? [];
      collection.push(issue);
      grouped.set(url, collection);
    }
  }

  const duplicateGroups = [...grouped.entries()]
    .map(([mondayUrl, relatedIssues]) => ({ mondayUrl, relatedIssues }))
    .filter((entry) => entry.relatedIssues.length > 1)
    .sort((a, b) => b.relatedIssues.length - a.relatedIssues.length);

  console.log(`Scanned ${issues.length} Jira issues in project ${args.projectKey}.`);
  console.log(`Found ${duplicateGroups.length} Monday items with duplicate Jira issues.`);

  if (duplicateGroups.length === 0) {
    return;
  }

  let plannedDeleteCount = 0;
  const deletionKeys: string[] = [];

  for (const group of duplicateGroups) {
    const keeper = pickIssueToKeep(group.relatedIssues, args.keep);
    const toDelete = group.relatedIssues.filter((issue) => issue.key !== keeper.key);

    plannedDeleteCount += toDelete.length;

    console.log(`\nMonday: ${group.mondayUrl}`);
    console.log(` Keep: ${keeper.key} (${keeper.fields.summary ?? "(no summary)"})`);
    console.log(` Remove: ${toDelete.map((issue) => issue.key).join(", ")}`);

    for (const issue of toDelete) {
      deletionKeys.push(issue.key);
    }
  }

  if (args.limit) {
    console.log(`\nLimit enabled: first ${args.limit} duplicates will be processed.`);
  }

  console.log(`\nPlanned duplicate removals: ${plannedDeleteCount}`);

  if (!args.apply) {
    console.log("Dry run only. Re-run with --apply --delete to delete duplicates.");
    return;
  }

  if (!args.delete) {
    throw new Error("Apply mode requires --delete to avoid accidental destructive actions.");
  }

  const limitedKeys = args.limit ? deletionKeys.slice(0, args.limit) : deletionKeys;

  let removed = 0;
  for (const key of limitedKeys) {
    await jiraRequest<void>({
      account,
      path: `/rest/api/3/issue/${key}`,
      method: "DELETE"
    });

    removed += 1;
    console.log(`Deleted ${key} (${removed}/${limitedKeys.length})`);
  }

  console.log(`\nDeleted ${removed} duplicate issues.`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`jira-dedupe failed: ${message}`);
  process.exitCode = 1;
});
