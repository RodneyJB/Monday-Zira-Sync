import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type BoardMapping = {
  boardId: string;
  accountId: string;
  projectKey: string;
  projectName: string;
  updatedAt: string;
};

const storagePath = resolve(process.cwd(), "data", "mappings.json");
let cache = new Map<string, BoardMapping>();
let loaded = false;

async function loadStore(): Promise<void> {
  if (loaded) {
    return;
  }

  try {
    const raw = await readFile(storagePath, "utf8");
    const parsed = JSON.parse(raw) as BoardMapping[];
    cache = new Map(parsed.map((entry) => [entry.boardId, entry]));
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
  return cache.get(boardId) ?? null;
}

export async function saveBoardMapping(input: {
  boardId: string;
  accountId: string;
  projectKey: string;
  projectName: string;
}): Promise<BoardMapping> {
  await loadStore();

  const mapping: BoardMapping = {
    ...input,
    updatedAt: new Date().toISOString()
  };

  cache.set(mapping.boardId, mapping);
  await persistStore();

  return mapping;
}
