import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type BoardMapping = {
  boardId: string;
  boardViewId?: string;
  accountId: string;
  projectKey: string;
  projectName: string;
  syncTrigger: "manual" | "status_change";
  statusColumnId?: string;
  triggerStatusLabel?: string;
  keepSynced: boolean;
  nameSource: "item_name" | "text_column";
  nameColumnId?: string;
  attachmentSource: "item_assets" | "file_column";
  attachmentColumnId?: string;
  nameTranslations: Record<string, string>;
  targetLanguage: string;
  updatedAt: string;
};

const storagePath = resolve(process.cwd(), "data", "mappings.json");
let cache = new Map<string, BoardMapping>();
let loaded = false;

function normalizeMapping(
  record: Omit<
    BoardMapping,
    | "syncTrigger"
    | "keepSynced"
    | "nameSource"
    | "attachmentSource"
    | "nameTranslations"
    | "targetLanguage"
  > & {
  syncTrigger?: "manual" | "status_change";
  keepSynced?: boolean;
    nameSource?: "item_name" | "text_column";
    attachmentSource?: "item_assets" | "file_column";
    nameTranslations?: Record<string, string>;
    targetLanguage?: string;
  }
): BoardMapping {
  return {
    ...record,
    syncTrigger: record.syncTrigger ?? "manual",
    keepSynced: record.keepSynced ?? true,
    nameSource: record.nameSource ?? "item_name",
    attachmentSource: record.attachmentSource ?? "item_assets",
    nameTranslations: record.nameTranslations ?? {},
    targetLanguage: record.targetLanguage ?? "none"
  };
}

async function loadStore(): Promise<void> {
  if (loaded) {
    return;
  }

  try {
    const raw = await readFile(storagePath, "utf8");
    const parsed = JSON.parse(raw) as Array<
      Omit<
        BoardMapping,
        | "syncTrigger"
        | "keepSynced"
        | "nameSource"
        | "attachmentSource"
        | "nameTranslations"
        | "targetLanguage"
      > & {
        syncTrigger?: "manual" | "status_change";
        keepSynced?: boolean;
        nameSource?: "item_name" | "text_column";
        attachmentSource?: "item_assets" | "file_column";
        nameTranslations?: Record<string, string>;
        targetLanguage?: string;
      }
    >;
    cache = new Map(parsed.map((entry) => [entry.boardId, normalizeMapping(entry)]));
  } catch {
    cache = new Map();
  }

  loaded = true;
}

async function persistStore(): Promise<void> {
  const payload = JSON.stringify([...cache.values()], null, 2);
  await mkdir(dirname(storagePath), { recursive: true });
  await writeFile(storagePath, payload, "utf8");
}

export async function getBoardMapping(boardId: string): Promise<BoardMapping | null> {
  await loadStore();
  const mapping = cache.get(boardId);
  return mapping ? normalizeMapping(mapping) : null;
}

export async function saveBoardMapping(input: {
  boardId: string;
  boardViewId?: string;
  accountId: string;
  projectKey: string;
  projectName: string;
  syncTrigger?: "manual" | "status_change";
  statusColumnId?: string;
  triggerStatusLabel?: string;
  keepSynced?: boolean;
  nameSource?: "item_name" | "text_column";
  nameColumnId?: string;
  attachmentSource?: "item_assets" | "file_column";
  attachmentColumnId?: string;
  nameTranslations?: Record<string, string>;
  targetLanguage?: string;
}): Promise<BoardMapping> {
  await loadStore();

  const mapping: BoardMapping = {
    ...input,
    syncTrigger: input.syncTrigger ?? "manual",
    keepSynced: input.keepSynced ?? true,
    nameSource: input.nameSource ?? "item_name",
    attachmentSource: input.attachmentSource ?? "item_assets",
    nameTranslations: input.nameTranslations ?? {},
    targetLanguage: input.targetLanguage ?? "none",
    updatedAt: new Date().toISOString()
  };

  cache.set(mapping.boardId, mapping);
  await persistStore();

  return mapping;
}
