import { z } from "zod";

const jiraAccountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.url(),
  email: z.email(),
  apiToken: z.string().min(1)
});

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATA_DIR: z.string().default("data"),
  MONDAY_API_TOKEN: z.string().optional(),
  MONDAY_API_VERSION: z.string().default("2025-04"),
  MONDAY_ACCOUNT_BASE_URL: z.url().default("https://bootepolch.monday.com"),
  MONDAY_SIGNING_SECRET: z.string().optional(),
  JIRA_ACCOUNTS_JSON: z.string().optional(),
  ZIRA_ACCOUNTS_JSON: z.string().optional()
}).passthrough();

const parsedEnv = envSchema.safeParse(process.env);

const safeEnv = parsedEnv.success ? parsedEnv.data : {
  NODE_ENV: "development",
  PORT: 3000,
  DATA_DIR: "data",
  MONDAY_API_TOKEN: undefined,
  MONDAY_API_VERSION: "2025-04",
  MONDAY_ACCOUNT_BASE_URL: "https://bootepolch.monday.com",
  MONDAY_SIGNING_SECRET: undefined,
  JIRA_ACCOUNTS_JSON: undefined,
  ZIRA_ACCOUNTS_JSON: undefined
} as const;

if (!parsedEnv.success) {
  console.warn("Environment validation failed; using safe defaults instead of exiting. Details:", parsedEnv.error.message);
}

function parseJiraAccounts(raw: string | undefined) {
  if (!raw) {
    return [] as Array<z.infer<typeof jiraAccountSchema>>;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    console.warn("JIRA_ACCOUNTS_JSON is not valid JSON; continuing without Jira accounts.");
    return [] as Array<z.infer<typeof jiraAccountSchema>>;
  }

  const parsed = z.array(jiraAccountSchema).safeParse(parsedJson);
  if (!parsed.success) {
    console.warn("JIRA_ACCOUNTS_JSON is invalid; continuing without Jira accounts.", parsed.error.message);
    return [] as Array<z.infer<typeof jiraAccountSchema>>;
  }

  return parsed.data;
}

const rawJiraAccountsJson = safeEnv.JIRA_ACCOUNTS_JSON ?? safeEnv.ZIRA_ACCOUNTS_JSON;

export const config = {
  ...safeEnv,
  jiraAccounts: parseJiraAccounts(rawJiraAccountsJson)
};

export type JiraAccountConfig = (typeof config.jiraAccounts)[number];
