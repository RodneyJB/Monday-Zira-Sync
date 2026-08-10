declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NODE_ENV?: "development" | "production" | "test";
      PORT?: string;
      MONDAY_SIGNING_SECRET?: string;
      JIRA_ACCOUNTS_JSON?: string;
    }
  }
}

export {};
