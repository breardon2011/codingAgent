import { expect } from "chai";
import { describe, it } from "mocha";
import { promises as fs } from "fs";
import path from "path";
import { getFileReference, inlineOrRef } from "../utils/fileReference";

describe("File Reference Utils", () => {
  const REF_DIR = path.join(process.cwd(), ".file_refs");
  const CACHE_FILE = path.join(REF_DIR, "cache.json");

  it("should create and return a stable reference and write file contents", async () => {
    const uniqueContent = `hello-ref-${Date.now()}-${Math.random()}`;
    const ref1 = await getFileReference(uniqueContent);
    const ref2 = await getFileReference(uniqueContent);

    expect(ref1).to.equal(ref2);
    expect(ref1).to.match(/^<file:[a-f0-9]{64}>$/);

    const hash = ref1.slice("<file:".length, -1);
    const storedPath = path.join(REF_DIR, `${hash}.txt`);

    const stored = await fs.readFile(storedPath, "utf8");
    expect(stored).to.equal(uniqueContent);
  });

  it("should persist mapping to cache.json", async () => {
    const uniqueContent = `cache-ref-${Date.now()}-${Math.random()}`;
    const ref = await getFileReference(uniqueContent);
    const hash = ref.slice("<file:".length, -1);

    const cacheRaw = await fs.readFile(CACHE_FILE, "utf8");
    const cache = JSON.parse(cacheRaw) as Record<string, string>;

    expect(cache).to.have.property(hash, ref);
  });

  it("inlineOrRef should return inline text when below threshold", async () => {
    const smallText = "short";
    const result = await inlineOrRef(smallText, 10);
    expect(result).to.equal(smallText);
  });

  it("inlineOrRef should return a file reference when above threshold", async () => {
    const largeText = "x".repeat(1000);
    const result = await inlineOrRef(largeText, 500);
    expect(result).to.match(/^<file:[a-f0-9]{64}>$/);

    const hash = result.slice("<file:".length, -1);
    const storedPath = path.join(REF_DIR, `${hash}.txt`);
    const stored = await fs.readFile(storedPath, "utf8");
    expect(stored).to.equal(largeText);
  });
});
