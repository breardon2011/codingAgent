import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { logger } from "./logger";

const CACHE: Record<string, string> = {};
const REF_DIR = path.join(process.cwd(), ".file_refs");
const CACHE_FILE = path.join(REF_DIR, "cache.json");

async function ensureDir() {
  await fs.mkdir(REF_DIR, { recursive: true });
}

async function loadCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf8");
    Object.assign(CACHE, JSON.parse(raw));
  } catch {
    /* first run – no cache yet */
  }
}

async function persistCache() {
  await fs.writeFile(CACHE_FILE, JSON.stringify(CACHE), "utf8");
}

export async function getFileReference(content: string): Promise<string> {
  if (!Object.keys(CACHE).length) await loadCache();

  const hash = createHash("sha256").update(content).digest("hex");
  if (CACHE[hash]) return CACHE[hash]; // already stored

  await ensureDir();
  const fullPath = path.join(REF_DIR, `${hash}.txt`);
  await fs.writeFile(fullPath, content, "utf8");

  const ref = `<file:${hash}>`;
  CACHE[hash] = ref;
  await persistCache();
  logger.debug("Stored new file-reference", { hash });

  return ref;
}

/** return ref if text is large, otherwise the raw text */
export async function inlineOrRef(
  text: string,
  threshold = 500
): Promise<string> {
  return text.length > threshold ? getFileReference(text) : text;
}
