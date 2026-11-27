import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElectronFiles } from "./files";

let directory: string;
const cleanups: Array<() => unknown> = [];

beforeEach(async () => {
  directory = await mkdtemp(join(await realpath(tmpdir()), "markra-watches-"));
});

afterEach(async () => {
  cleanups.splice(0).forEach((stop) => stop());
  await rm(directory, { recursive: true, force: true });
});

async function service(selectedFile: string | null = null, selectedFolder: string | null = null) {
  const result = await createElectronFiles({
    userDataPath: join(directory, "settings"),
    chooseFile: async () => selectedFile,
    chooseFolder: async () => selectedFolder,
    chooseSavePath: async () => null
  });
  if (selectedFile) await result.files.openMarkdownFile();
  if (selectedFolder) await result.files.openMarkdownFolder();
  return result.files;
}

describe("Electron file watches", () => {
  it("notifies both windows across repeated atomic saves, deletion and recreation", async () => {
    const path = join(directory, "中文.md");
    await writeFile(path, "initial");
    const files = await service(path);
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = await files.watchMarkdownFile(path, first);
    cleanups.push(stopFirst, await files.watchMarkdownFile(path, second));

    for (const contents of ["first save", "second save"]) {
      first.mockClear();
      second.mockClear();
      await files.saveMarkdownFile({ path, contents, suggestedName: "中文.md" });
      await expect.poll(() => first.mock.calls.length).toBeGreaterThan(0);
      await expect.poll(() => second.mock.calls.length).toBeGreaterThan(0);
      expect(first.mock.lastCall).toEqual([path]);
      expect((await files.readMarkdownFile(path)).content).toBe(contents);
    }

    second.mockClear();
    await rm(path);
    await expect.poll(() => second.mock.calls.length).toBeGreaterThan(0);
    stopFirst();
    first.mockClear();
    second.mockClear();
    await writeFile(path, "recreated");
    await expect.poll(() => second.mock.calls.length).toBeGreaterThan(0);
    expect(first).not.toHaveBeenCalled();
  });

  it("refreshes a selected tree for nested additions, changes, renames and removals", async () => {
    const root = join(directory, "notes");
    await mkdir(join(root, "nested"), { recursive: true });
    const files = await service(null, root);
    const changed = vi.fn();
    cleanups.push(await files.watchMarkdownTree(root, changed));
    const path = join(root, "nested", "note.md");
    const moved = join(root, "nested", "moved.md");
    for (const change of [
      () => writeFile(path, "new"),
      () => writeFile(path, "updated"),
      () => rename(path, moved),
      () => rm(moved),
      () => mkdir(join(root, "new-folder")),
      () => writeFile(join(root, "new-folder", "new.md"), "new folder")
    ]) {
      changed.mockClear();
      await change();
      await expect.poll(() => changed.mock.calls.length).toBeGreaterThan(0);
      expect(changed.mock.calls.every(([value]) => value === root)).toBe(true);
    }
  });

  it("does not grant a selected file's siblings or symlink targets through watches", async () => {
    const selected = join(directory, "selected.md");
    const privateFile = join(directory, "private.md");
    await Promise.all([writeFile(selected, "selected"), writeFile(privateFile, "private")]);
    const files = await service(selected);
    await expect(files.watchMarkdownFile(privateFile, vi.fn())).rejects.toThrow();
    await expect(files.watchMarkdownTree(join(directory, "settings"), vi.fn())).rejects.toThrow();
    const changed = vi.fn();
    cleanups.push(await files.watchMarkdownTree(directory, changed));
    await writeFile(privateFile, "private change");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(changed).not.toHaveBeenCalled();
    await writeFile(selected, "selected change");
    await expect.poll(() => changed.mock.calls.length).toBeGreaterThan(0);
    await rm(selected);
    await symlink(privateFile, selected);
    await expect(files.watchMarkdownFile(selected, vi.fn())).rejects.toThrow();
    await expect(files.readMarkdownFile(selected)).rejects.toThrow();
  });
});
