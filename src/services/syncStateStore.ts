import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type SyncedItemRecord = {
  boardId: string;
  itemId: string;
  issueKey: string;
  syncedAt: string;
};

const storagePath = resolve(process.cwd(), "data", "synced-items.json");
let loaded = false;
let cache = new Map<string, SyncedItemRecord>();

function makeKey(boardId: string, itemId: string): string {
  return `${boardId}:${itemId}`;
}

async function loadStore(): Promise<void> {
  if (loaded) {
    return;
  }

  try {
    const raw = await readFile(storagePath, "utf8");
    const parsed = JSON.parse(raw) as SyncedItemRecord[];
    cache = new Map(parsed.map((entry) => [makeKey(entry.boardId, entry.itemId), entry]));
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

export async function getSyncedItem(boardId: string, itemId: string): Promise<SyncedItemRecord | null> {
  await loadStore();
  return cache.get(makeKey(boardId, itemId)) ?? null;
}

export async function setSyncedItem(input: {
  boardId: string;
  itemId: string;
  issueKey: string;
}): Promise<SyncedItemRecord> {
  await loadStore();

  const record: SyncedItemRecord = {
    ...input,
    syncedAt: new Date().toISOString()
  };

  cache.set(makeKey(record.boardId, record.itemId), record);
  await persistStore();

  return record;
}
