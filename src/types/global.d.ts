declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NODE_ENV?: "development" | "production" | "test";
      PORT?: string;
      MONDAY_API_TOKEN?: string;
      MONDAY_API_VERSION?: string;
      MONDAY_ACCOUNT_BASE_URL?: string;
      MONDAY_SIGNING_SECRET?: string;
      JIRA_ACCOUNTS_JSON?: string;
    }
  }
}

export {};
