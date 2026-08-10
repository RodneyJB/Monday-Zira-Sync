import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type BoardMapping = {
  boardId: string;
  accountId: string;
  projectKey: string;
  projectName: string;
  syncTrigger: "manual" | "status_change";
  statusColumnId?: string;
  triggerStatusLabel?: string;
  keepSynced: boolean;
  updatedAt: string;
};

const storagePath = resolve(process.cwd(), "data", "mappings.json");
let cache = new Map<string, BoardMapping>();
let loaded = false;

function normalizeMapping(record: Omit<BoardMapping, "syncTrigger" | "keepSynced"> & {
  syncTrigger?: "manual" | "status_change";
  keepSynced?: boolean;
}): BoardMapping {
  return {
    ...record,
    syncTrigger: record.syncTrigger ?? "manual",
    keepSynced: record.keepSynced ?? true
  };
}

async function loadStore(): Promise<void> {
  if (loaded) {
    return;
  }

  try {
    const raw = await readFile(storagePath, "utf8");
    const parsed = JSON.parse(raw) as Array<
      Omit<BoardMapping, "syncTrigger" | "keepSynced"> & {
        syncTrigger?: "manual" | "status_change";
        keepSynced?: boolean;
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
  accountId: string;
  projectKey: string;
  projectName: string;
  syncTrigger?: "manual" | "status_change";
  statusColumnId?: string;
  triggerStatusLabel?: string;
  keepSynced?: boolean;
}): Promise<BoardMapping> {
  await loadStore();

  const mapping: BoardMapping = {
    ...input,
    syncTrigger: input.syncTrigger ?? "manual",
    keepSynced: input.keepSynced ?? true,
    updatedAt: new Date().toISOString()
  };

  cache.set(mapping.boardId, mapping);
  await persistStore();

  return mapping;
}
