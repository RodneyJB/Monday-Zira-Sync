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

type MondayBoardColumnsResponse = {
  boards: Array<{
    id: string;
    columns: Array<{
      id: string;
      title: string;
      type: string;
      settings_str: string;
    }>;
  }>;
};

type MondayBoardSyncColumnsResponse = {
  boards: Array<{
    id: string;
    columns: Array<{
      id: string;
      title: string;
      type: string;
    }>;
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
      url?: string | null;
      public_url: string | null;
      file_extension: string;
    }>;
    column_values: Array<{
      id: string;
      type: string;
      text: string;
      value: string;
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
  columnValues: Array<{
    id: string;
    type: string;
    text: string;
    value: string;
  }>;
};

export type MondayStatusColumn = {
  id: string;
  title: string;
  labels: string[];
};

export type MondaySyncColumn = {
  id: string;
  title: string;
  type: string;
};

export type MondaySyncColumns = {
  nameColumns: MondaySyncColumn[];
  fileColumns: MondaySyncColumn[];
};

function parseStatusLabels(settingsRaw: string): string[] {
  if (!settingsRaw) {
    return [];
  }

  try {
    const parsed = JSON.parse(settingsRaw) as {
      labels?: Record<string, string>;
    };

    const labels = Object.values(parsed.labels ?? {})
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    return [...new Set(labels)];
  } catch {
    return [];
  }
}

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
        items_page(limit: 100) {
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

export function resolveMondayAssetPublicUrl(asset: { url?: string | null; public_url?: string | null }): string {
  return asset.public_url || asset.url || "";
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
          url
          public_url
          file_extension
        }
        column_values {
          id
          type
          text
          value
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
      publicUrl: resolveMondayAssetPublicUrl(asset),
      fileExtension: asset.file_extension
    })),
    columnValues: (item.column_values ?? []).map((column) => ({
      id: column.id,
      type: column.type,
      text: column.text ?? "",
      value: column.value ?? ""
    }))
  };
}

export async function getMondayBoardStatusColumns(boardId: string): Promise<MondayStatusColumn[]> {
  const query = `
    query ($boardId: [ID!]) {
      boards(ids: $boardId) {
        id
        columns {
          id
          title
          type
          settings_str
        }
      }
    }
  `;

  const data = await mondayGraphql<MondayBoardColumnsResponse>(query, { boardId: [boardId] });
  const board = data.boards[0];

  if (!board) {
    throw new Error("Board not found or not accessible with this token.");
  }

  return board.columns
    .filter((column) => column.type === "color" || column.type === "status")
    .map((column) => ({
      id: column.id,
      title: column.title,
      labels: parseStatusLabels(column.settings_str)
    }));
}

export async function getMondayBoardSyncColumns(boardId: string): Promise<MondaySyncColumns> {
  const query = `
    query ($boardId: [ID!]) {
      boards(ids: $boardId) {
        id
        columns {
          id
          title
          type
        }
      }
    }
  `;

  const data = await mondayGraphql<MondayBoardSyncColumnsResponse>(query, { boardId: [boardId] });
  const board = data.boards[0];

  if (!board) {
    throw new Error("Board not found or not accessible with this token.");
  }

  const nameColumnTypes = new Set(["name", "text", "long-text"]);
  const fileColumnTypes = new Set(["file"]);

  return {
    nameColumns: board.columns
      .filter((column) => nameColumnTypes.has(column.type))
      .map((column) => ({ id: column.id, title: column.title, type: column.type })),
    fileColumns: board.columns
      .filter((column) => fileColumnTypes.has(column.type))
      .map((column) => ({ id: column.id, title: column.title, type: column.type }))
  };
}
