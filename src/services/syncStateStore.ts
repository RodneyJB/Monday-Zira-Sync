import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { config } from "../config.js";

export type SyncedItemRecord = {
  boardId: string;
  itemId: string;
  issueKey: string;
  uploadedAssetIds: string[];
  lastStatusLabel?: string;
  syncedAt: string;
};

const storagePath = resolve(process.cwd(), config.DATA_DIR, "synced-items.json");
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
  uploadedAssetIds?: string[];
  lastStatusLabel?: string;
}): Promise<SyncedItemRecord> {
  await loadStore();

  const existing = cache.get(makeKey(input.boardId, input.itemId));

  const record: SyncedItemRecord = {
    ...input,
    uploadedAssetIds: input.uploadedAssetIds ?? existing?.uploadedAssetIds ?? [],
    lastStatusLabel: input.lastStatusLabel ?? existing?.lastStatusLabel,
    syncedAt: new Date().toISOString()
  };

  cache.set(makeKey(record.boardId, record.itemId), record);
  await persistStore();

  return record;
}
