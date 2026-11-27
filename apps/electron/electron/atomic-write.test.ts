import { mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicWrite } from "./atomic-write";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const mockedOpen = vi.fn(fs.open);
  return { ...fs, default: { ...fs, open: mockedOpen }, open: mockedOpen };
});

let directory: string;
let path: string;

beforeEach(async () => {
  directory = await mkdtemp(join(await realpath(tmpdir()), "markra-atomic-"));
  path = join(directory, "文档.md");
  await writeFile(path, "原有内容");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe("atomic writes", () => {
  it.each([0o600, 0o640])("replaces complete content with the requested %o permissions", async (mode) => {
    await atomicWrite(path, "新的完整内容", mode);
    expect(await readFile(path, "utf8")).toBe("新的完整内容");
    expect((await stat(path)).mode & 0o777).toBe(mode);
    expect(await readdir(directory)).toEqual(["文档.md"]);
  });

  it.each(["writeFile", "sync", "close"] as const)("preserves the original and removes temporary files if %s fails", async (method) => {
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const file = await fs.open(...args);
      const close = file.close.bind(file);
      vi.spyOn(file, method).mockImplementationOnce(async () => {
        if (method === "close") await close();
        throw new Error("simulated disk failure");
      });
      return file;
    });
    await expect(atomicWrite(path, "替换内容", 0o600)).rejects.toThrow("simulated disk failure");
    expect(await readFile(path, "utf8")).toBe("原有内容");
    expect(await readdir(directory)).toEqual(["文档.md"]);
  });

  it("rechecks the caller's safety condition before replacing the original", async () => {
    await expect(atomicWrite(path, "替换内容", 0o600, async () => {
      expect(await readFile(path, "utf8")).toBe("原有内容");
      throw new Error("unsafe destination");
    })).rejects.toThrow("unsafe destination");
    expect(await readFile(path, "utf8")).toBe("原有内容");
    expect(await readdir(directory)).toEqual(["文档.md"]);
  });
});
