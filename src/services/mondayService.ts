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

type MondayItemSyncResponse = {
  items: Array<{
    id: string;
    name: string;
    board: {
      id: string;
      name: string;
    };
    assets: Array<{
      id: string;
      name: string;
          public_url: string | null;
      file_extension: string;
    }>;
  }>;
};

export type MondaySyncItem = {
  id: string;
  name: string;
  boardId: string;
  boardName: string;
  assets: Array<{
    id: string;
    name: string;
    publicUrl: string;
    fileExtension: string;
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

export async function getMondayItemForSync(itemId: string): Promise<MondaySyncItem> {
  const query = `
    query ($itemId: [ID!]) {
      items(ids: $itemId) {
        id
        name
        board {
          id
          name
        }
        assets {
          id
          name
          public_url
          file_extension
        }
      }
    }
  `;

  const data = await mondayGraphql<MondayItemSyncResponse>(query, { itemId: [itemId] });
  const item = data.items[0];

  if (!item) {
    throw new Error("Monday item not found or not accessible with this token.");
  }

  return {
    id: item.id,
    name: item.name,
    boardId: item.board.id,
    boardName: item.board.name,
    assets: (item.assets ?? []).map((asset) => ({
      id: asset.id,
      name: asset.name,
      publicUrl: asset.public_url ?? "",
      fileExtension: asset.file_extension
    }))
  };
}
