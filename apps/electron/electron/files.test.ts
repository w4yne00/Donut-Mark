import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createElectronFiles } from "./files";

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "markra-files-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Electron file runtime", () => {
  it("opens, saves and reopens a selected Chinese Markdown file after restarting", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "中文文档.md");
    await writeFile(path, "# 初稿\n\n离线编辑。\n", "utf8");
    const options = {
      userDataPath: join(directory, "settings"),
      chooseFile: async () => path,
      chooseFolder: async () => null,
      chooseSavePath: async () => null
    };
    const { files } = await createElectronFiles(options);

    expect(await files.openMarkdownPath()).toEqual({
      kind: "file",
      file: { path, name: "中文文档.md", content: "# 初稿\n\n离线编辑。\n", sizeBytes: 26 }
    });
    expect(await files.saveMarkdownFile({ path, suggestedName: "中文文档.md", contents: "# 终稿\n\n中文保存成功。\n" }))
      .toEqual({ path, name: "中文文档.md" });
    expect(await readFile(path, "utf8")).toBe("# 终稿\n\n中文保存成功。\n");

    const restarted = await createElectronFiles(options);
    expect((await restarted.files.readMarkdownFile(path)).content).toBe("# 终稿\n\n中文保存成功。\n");
  });

  it("lists and reads Markdown inside a user-selected folder after restarting", async () => {
    const directory = await temporaryDirectory();
    const folder = join(directory, "笔记");
    await mkdir(join(folder, "子目录"), { recursive: true });
    await writeFile(join(folder, "子目录", "说明.md"), "文件夹内的中文。", "utf8");
    await writeFile(join(folder, "不应读取.key"), "secret", "utf8");
    const options = {
      userDataPath: join(directory, "settings"),
      chooseFile: async () => null,
      chooseFolder: async () => folder,
      chooseSavePath: async () => null
    };
    const { files } = await createElectronFiles(options);
    expect(await files.openMarkdownFolder()).toEqual({ path: folder, name: "笔记" });
    expect((await files.listMarkdownFilesForPath(folder)).map((entry) => entry.relativePath))
      .toEqual(["子目录", "子目录/说明.md"]);

    const restarted = await createElectronFiles(options);
    expect((await restarted.files.readMarkdownFile(join(folder, "子目录", "说明.md"))).content).toBe("文件夹内的中文。");
    await expect(files.readMarkdownFile(join(folder, "不应读取.key"))).rejects.toThrow();
  });

  it("lists only previously selected files when the file tree asks for their parent directory", async () => {
    const directory = await temporaryDirectory();
    const first = join(directory, "first.md");
    const second = join(directory, "second.md");
    const privateFile = join(directory, "private.md");
    await Promise.all([writeFile(first, "first"), writeFile(second, "second"), writeFile(privateFile, "private")]);
    let selected = first;
    const { files } = await createElectronFiles({
      userDataPath: join(directory, "settings"),
      chooseFile: async () => selected,
      chooseFolder: async () => null,
      chooseSavePath: async () => null
    });
    await files.openMarkdownFile();
    expect((await files.listMarkdownFilesForPath(directory)).map((file) => file.name)).toEqual(["first.md"]);
    selected = second;
    await files.openMarkdownFile();
    expect((await files.listMarkdownFilesForPath(first)).map((file) => file.name)).toEqual(["first.md", "second.md"]);
    expect((await files.listMarkdownFilesForPath(directory)).map((file) => file.name)).toEqual(["first.md", "second.md"]);
    await expect(files.readMarkdownFile(privateFile)).rejects.toThrow();
    await expect(files.listMarkdownFilesForPath(join(directory, "settings"))).rejects.toThrow();
    await rm(first);
    expect((await files.listMarkdownFilesForPath(directory)).map((file) => file.name)).toEqual(["second.md"]);
  });

  it.each(["md", "markdown", "mdown", "mkd", "txt"])("opens and saves the supported .%s extension", async (extension) => {
    const directory = await temporaryDirectory();
    const path = join(directory, `笔记.${extension}`);
    await writeFile(path, "初稿");
    const { files } = await createElectronFiles({
      userDataPath: join(directory, "settings"),
      chooseFile: async () => path,
      chooseFolder: async () => null,
      chooseSavePath: async () => null
    });
    expect((await files.openMarkdownFile())?.content).toBe("初稿");
    await files.saveMarkdownFile({ path, contents: "终稿", suggestedName: `笔记.${extension}` });
    expect((await files.readMarkdownFile(path)).content).toBe("终稿");
  });

  it("reads local images relative to a selected document without granting unrelated file access", async () => {
    const directory = await temporaryDirectory();
    const folder = join(directory, "文档");
    await mkdir(join(folder, "图片"), { recursive: true });
    const documentPath = join(folder, "说明.md");
    await writeFile(documentPath, "![本地图](图片/示例.png)", "utf8");
    await writeFile(join(folder, "图片", "示例.png"), Buffer.from([137, 80, 78, 71]));
    await writeFile(join(directory, "外部.png"), Buffer.from([0, 1]));
    const { files } = await createElectronFiles({
      userDataPath: join(directory, "settings"),
      chooseFile: async () => documentPath,
      chooseFolder: async () => null,
      chooseSavePath: async () => null
    });
    await files.openMarkdownFile();
    expect(await files.readMarkdownImageFile({ documentPath, src: "图片/示例.png" })).toEqual({
      path: join(folder, "图片", "示例.png"), src: "图片/示例.png", mimeType: "image/png", dataUrl: "data:image/png;base64,iVBORw=="
    });
    await expect(files.readMarkdownImageFile({ documentPath, src: "../外部.png" })).rejects.toThrow();
    await expect(files.readMarkdownImageFile({ documentPath, src: "https://example.com/远程.png" })).rejects.toThrow();
    await expect(files.readMarkdownImageFile({ documentPath, src: "说明.md" })).rejects.toThrow();
  });

  it("does not read or overwrite files without an explicit picker grant, including symlinks", async () => {
    const directory = await temporaryDirectory();
    const selected = join(directory, "selected.md");
    const privateFile = join(directory, "private.md");
    const link = join(directory, "link.md");
    await writeFile(selected, "selected");
    await writeFile(privateFile, "private");
    await symlink(privateFile, link);
    let chosen = selected;
    const { files } = await createElectronFiles({
      userDataPath: join(directory, "settings"),
      chooseFile: async () => chosen,
      chooseFolder: async () => null,
      chooseSavePath: async () => link
    });
    await files.openMarkdownFile();
    await expect(files.readMarkdownFile(privateFile)).rejects.toThrow();
    await expect(files.saveMarkdownFile({ path: privateFile, contents: "changed", suggestedName: "private.md" })).rejects.toThrow();
    chosen = link;
    await expect(files.openMarkdownFile()).rejects.toThrow();
    await expect(files.saveMarkdownFile({ path: null, contents: "changed", suggestedName: "link.md" })).rejects.toThrow();
    await rm(selected);
    await symlink(privateFile, selected);
    await expect(files.readMarkdownFile(selected)).rejects.toThrow();
    await expect(files.saveMarkdownFile({ path: selected, contents: "changed", suggestedName: "selected.md" })).rejects.toThrow();
    expect(await readFile(privateFile, "utf8")).toBe("private");
  });

  it("returns null for canceled dialogs and leaves an existing file intact when saving fails", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "readonly.md");
    await writeFile(path, "original");
    const { files, authorizeFile } = await createElectronFiles({
      userDataPath: join(directory, "settings"),
      chooseFile: async () => null,
      chooseFolder: async () => null,
      chooseSavePath: async () => null
    });
    expect(await files.openMarkdownPath()).toBeNull();
    expect(await files.openMarkdownFolder()).toBeNull();
    expect(await files.saveMarkdownFile({ path: null, contents: "new", suggestedName: "new.md" })).toBeNull();
    await authorizeFile(path);
    await chmod(path, 0o400);
    try {
      await expect(files.saveMarkdownFile({ path, contents: "changed", suggestedName: "readonly.md" })).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe("original");
    } finally {
      await chmod(path, 0o600);
    }
  });
});
