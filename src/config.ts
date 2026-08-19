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

if (!parsedEnv.success) {
  throw new Error(`Invalid environment: ${parsedEnv.error.message}`);
}

function parseJiraAccounts(raw: string | undefined) {
  if (!raw) {
    return [] as Array<z.infer<typeof jiraAccountSchema>>;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new Error("JIRA_ACCOUNTS_JSON must be valid JSON.");
  }

  const parsed = z.array(jiraAccountSchema).safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`JIRA_ACCOUNTS_JSON is invalid: ${parsed.error.message}`);
  }

  return parsed.data;
}

const rawJiraAccountsJson = parsedEnv.data.JIRA_ACCOUNTS_JSON ?? parsedEnv.data.ZIRA_ACCOUNTS_JSON;

export const config = {
  ...parsedEnv.data,
  jiraAccounts: parseJiraAccounts(rawJiraAccountsJson)
};

export type JiraAccountConfig = (typeof config.jiraAccounts)[number];
