import { constants, watch } from "node:fs";
import { lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { NativeMarkdownFolderFile, NativeMarkdownPickerLabels, SaveNativeMarkdownFileInput } from "@markra/app/runtime";
import type { ElectronFiles } from "./bridge";
import { atomicWrite } from "./atomic-write";

type FileRuntimeOptions = {
  userDataPath: string;
  onWatchError?: (error: unknown) => unknown;
  chooseFile: (labels?: NativeMarkdownPickerLabels) => Promise<string | null>;
  chooseFolder: (labels?: NativeMarkdownPickerLabels) => Promise<string | null>;
  chooseSavePath: (input: SaveNativeMarkdownFileInput) => Promise<string | null>;
};

function isMarkdownPath(path: string) {
  return /\.(?:md|markdown|mdown|mkd|txt)$/iu.test(path);
}

function isWithin(path: string, directory: string) {
  const suffix = relative(directory, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

function absolutePath(value: string) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0") || value.split(sep).includes("..")) {
    throw new Error("需要有效的本地绝对路径。");
  }
  return resolve(value);
}

async function rejectSymlinks(path: string, allowMissingFile = false) {
  let current = parse(path).root;
  const segments = path.slice(current.length).split(sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw Object.assign(new Error("不允许通过符号链接访问文件。"), { code: "ELOOP" });
      if (index < segments.length - 1 && !stat.isDirectory()) throw Object.assign(new Error("文件路径包含非目录项。"), { code: "ENOTDIR" });
    } catch (error) {
      if (allowMissingFile && index === segments.length - 1 && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export async function createElectronFiles(options: FileRuntimeOptions) {
  const grantsPath = join(options.userDataPath, "file-access.json");
  await mkdir(options.userDataPath, { recursive: true, mode: 0o700 });
  const grantedFiles = new Set<string>();
  const grantedDirectories = new Set<string>();
  try {
    await rejectSymlinks(grantsPath);
    const stored: unknown = JSON.parse(await readFile(grantsPath, "utf8"));
    if (!stored || typeof stored !== "object" || !("files" in stored) || !("directories" in stored) ||
      !Array.isArray(stored.files) || !Array.isArray(stored.directories) ||
      [...stored.files, ...stored.directories].some((path) => typeof path !== "string")) {
      throw new Error("文件授权记录损坏。");
    }
    stored.files.forEach((path) => grantedFiles.add(absolutePath(path)));
    stored.directories.forEach((path) => grantedDirectories.add(absolutePath(path)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let grantSave = Promise.resolve();

  async function saveGrants() {
    const write = () => atomicWrite(grantsPath, JSON.stringify({
      files: [...grantedFiles],
      directories: [...grantedDirectories]
    }), 0o600, () => rejectSymlinks(grantsPath, true));
    grantSave = grantSave.then(write, write);
    await grantSave;
  }

  function directoryAuthorized(path: string) {
    return [...grantedDirectories].some((directory) => isWithin(path, directory));
  }

  async function authorizeFile(value: string) {
    const path = absolutePath(value);
    if (!isMarkdownPath(path)) throw new Error("请选择 Markdown 或文本文件。");
    await rejectSymlinks(path, true);
    grantedFiles.add(path);
    await saveGrants();
    return path;
  }

  async function authorizedPath(value: string, allowMissingFile = false) {
    const path = absolutePath(value);
    if (!grantedFiles.has(path) && !directoryAuthorized(path)) throw new Error("文件尚未通过打开或保存对话框授权。");
    await rejectSymlinks(path, allowMissingFile && grantedFiles.has(path));
    return path;
  }

  async function treeRoot(value: string) {
    const path = absolutePath(value);
    const containsGrantedFile = [...grantedFiles].some((filePath) => dirname(filePath) === path);
    if (!grantedFiles.has(path) && !directoryAuthorized(path) && !containsGrantedFile) {
      throw new Error("文件夹尚未通过打开对话框授权。");
    }
    await rejectSymlinks(path);
    return (await lstat(path)).isDirectory() ? path : dirname(path);
  }

  function watchDirectory(root: string, onChange: (path: string) => unknown) {
    let active = true;
    // Watch the directory so replacing a file atomically does not detach its watch.
    const watcher = watch(root, { recursive: directoryAuthorized(root) }, (_event, filename) => {
      const candidates = filename === null
        ? directoryAuthorized(root) ? [root] : [...grantedFiles].filter((path) => dirname(path) === root)
        : [resolve(root, filename)];
      for (const path of candidates) {
        if (!isWithin(path, root) || (!grantedFiles.has(path) && !directoryAuthorized(path))) continue;
        rejectSymlinks(path, true).then(() => {
          if (active) onChange(path);
        }).catch((error: NodeJS.ErrnoException) => {
          if (!["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code ?? "")) fail(error);
        });
      }
    });
    function stop() {
      active = false;
      watcher.close();
    }
    function fail(error: unknown) {
      stop();
      if (options.onWatchError) options.onWatchError(error);
      else throw error;
    }
    watcher.on("error", fail);
    return stop;
  }

  const files: ElectronFiles = {
    async watchMarkdownFile(value, onChange, onTreeChange) {
      const path = await authorizedPath(value, true);
      if (!isMarkdownPath(path)) throw new Error("只能监听 Markdown 或文本文件。");
      return watchDirectory(dirname(path), (changedPath) => {
        if (changedPath === path || changedPath === dirname(path)) onChange(path);
        onTreeChange?.(dirname(path));
      });
    },
    async watchMarkdownTree(value, onTreeChange) {
      const root = await treeRoot(value);
      return watchDirectory(root, () => onTreeChange(root));
    },
    async readMarkdownFile(value) {
      const path = await authorizedPath(value);
      if (!isMarkdownPath(path)) throw new Error("只能读取 Markdown 或文本文件。");
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new Error("请选择普通文件。");
        const content = await file.readFile("utf8");
        return { path, name: basename(path), content, sizeBytes: stat.size };
      } finally {
        await file.close();
      }
    },
    async openMarkdownFile(labels) {
      const selected = await options.chooseFile(labels);
      return selected === null ? null : files.readMarkdownFile(await authorizeFile(selected));
    },
    async openMarkdownPath(labels) {
      const file = await files.openMarkdownFile(labels);
      return file === null ? null : { kind: "file", file };
    },
    async saveMarkdownFile(input) {
      if (typeof input.contents !== "string") throw new Error("Markdown 内容必须为文本。");
      const selected = input.path === null ? await options.chooseSavePath(input) : input.path;
      if (selected === null) return null;
      const path = input.path === null ? await authorizeFile(selected) : await authorizedPath(selected, true);
      if (!isMarkdownPath(path)) throw new Error("只能保存 Markdown 或文本文件。");
      let mode = 0o600;
      try {
        const existing = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
        try {
          const stat = await existing.stat();
          if (!stat.isFile()) throw new Error("保存目标必须为普通文件。");
          mode = stat.mode & 0o777;
        } finally {
          await existing.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await atomicWrite(path, input.contents, mode, () => rejectSymlinks(path, true));
      return { path, name: basename(path) };
    },
    async resolveMarkdownPath(value) {
      const path = await authorizedPath(value);
      if ((await lstat(path)).isDirectory()) return { kind: "folder", path, name: basename(path) };
      const file = await files.readMarkdownFile(path);
      return { kind: "file", path, name: file.name };
    },
    async listMarkdownFilesForPath(value) {
      const root = await treeRoot(value);
      if (!directoryAuthorized(root)) {
        const selectedFiles = [...grantedFiles].filter((filePath) => dirname(filePath) === root).sort();
        const entries: NativeMarkdownFolderFile[] = [];
        for (const filePath of selectedFiles) {
          try {
            await authorizedPath(filePath);
            const fileStat = await lstat(filePath);
            if (!fileStat.isFile()) throw new Error("授权文档已不再是普通文件。");
            const name = basename(filePath);
            entries.push({ path: filePath, name, relativePath: name, sizeBytes: fileStat.size });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        return entries;
      }
      const entries: NativeMarkdownFolderFile[] = [];
      async function visit(directory: string) {
        await rejectSymlinks(directory);
        const children = await readdir(directory, { withFileTypes: true });
        children.sort((left, right) => left.name.localeCompare(right.name));
        for (const child of children) {
          if (child.isSymbolicLink()) continue;
          const childPath = join(directory, child.name);
          if (child.isDirectory()) {
            entries.push({ path: childPath, name: child.name, relativePath: relative(root, childPath), kind: "folder" });
            await visit(childPath);
          } else if (child.isFile() && isMarkdownPath(childPath)) {
            const childStat = await lstat(childPath);
            entries.push({
              path: childPath,
              name: child.name,
              relativePath: relative(root, childPath),
              sizeBytes: childStat.size,
              modifiedAt: childStat.mtimeMs,
              createdAt: childStat.birthtimeMs
            });
          }
        }
      }
      await visit(root);
      return entries;
    },
    async openMarkdownFolder(labels) {
      const selected = await options.chooseFolder(labels);
      if (selected === null) return null;
      const path = absolutePath(selected);
      await rejectSymlinks(path);
      if (!(await lstat(path)).isDirectory()) throw new Error("请选择文件夹。");
      grantedDirectories.add(path);
      await saveGrants();
      return { path, name: basename(path) };
    },
    async readMarkdownImageFile(input) {
      const documentPath = await authorizedPath(input.documentPath);
      if (!isMarkdownPath(documentPath) || !(await lstat(documentPath)).isFile()) throw new Error("图片必须属于已打开的文档。");
      if (typeof input.src !== "string") throw new Error("图片地址必须为本地路径。");
      const source = decodeURIComponent(input.src.split(/[?#]/u, 1)[0]);
      if (/^[a-z][a-z\d+.-]*:|^\/\//iu.test(source) || source.includes("\0")) throw new Error("不允许读取远程图片。");
      const documentDirectory = dirname(documentPath);
      const path = resolve(documentDirectory, source);
      if (!isWithin(path, documentDirectory) && !directoryAuthorized(path)) throw new Error("图片不在授权目录内。");
      const mimeTypes: Record<string, string> = {
        ".avif": "image/avif", ".bmp": "image/bmp", ".gif": "image/gif", ".jpeg": "image/jpeg",
        ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp"
      };
      const mimeType = mimeTypes[extname(path).toLowerCase()];
      if (!mimeType) throw new Error("不支持此图片类型。");
      await rejectSymlinks(path);
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await file.stat()).isFile()) throw new Error("图片必须为普通文件。");
        const bytes = await file.readFile();
        return { path, src: input.src, mimeType, dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}` };
      } finally {
        await file.close();
      }
    }
  };

  return { files, authorizeFile };
}
