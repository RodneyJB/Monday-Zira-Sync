import axios from "axios";

import { config } from "../config.js";

type MondayGraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

type MondayViewerResponse = {
  me: {
    id: string;
    name: string;
    email: string;
  };
};

type MondayBoardResponse = {
  boards: Array<{
    id: string;
    name: string;
    items_page: {
      items: Array<{
        id: string;
        name: string;
      }>;
    };
  }>;
};

function assertMondayToken(): string {
  if (!config.MONDAY_API_TOKEN) {
    throw new Error("MONDAY_API_TOKEN is not configured.");
  }

  return config.MONDAY_API_TOKEN;
}

async function mondayGraphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const token = assertMondayToken();

  const response = await axios.post<MondayGraphqlResponse<T>>(
    "https://api.monday.com/v2",
    { query, variables },
    {
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
        "API-Version": config.MONDAY_API_VERSION
      },
      timeout: 15000
    }
  );

  if (response.data.errors && response.data.errors.length > 0) {
    throw new Error(response.data.errors.map((entry) => entry.message).join("; "));
  }

  if (!response.data.data) {
    throw new Error("Monday API returned no data.");
  }

  return response.data.data;
}

export async function getMondayMe() {
  const query = `
    query {
      me {
        id
        name
        email
      }
    }
  `;

  const data = await mondayGraphql<MondayViewerResponse>(query);
  return data.me;
}

export async function getMondayBoardSummary(boardId: string) {
  const query = `
    query ($boardId: [ID!]) {
      boards(ids: $boardId) {
        id
        name
        items_page(limit: 25) {
          items {
            id
            name
          }
        }
      }
    }
  `;

  const data = await mondayGraphql<MondayBoardResponse>(query, { boardId: [boardId] });
  const board = data.boards[0];

  if (!board) {
    throw new Error("Board not found or not accessible with this Monday token.");
  }

  return {
    id: board.id,
    name: board.name,
    items: board.items_page.items
  };
}
