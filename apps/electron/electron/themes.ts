import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isThemeCssFileName, maxThemeCssBytes } from "@markra/shared";
import { atomicWrite } from "./atomic-write";

async function useDirectory<T>(root: string, action: (openedPath: string) => Promise<T>) {
  const folder = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    // Kylin keeps the directory pinned for reads and the file manager's initial working directory.
    const openedPath = process.platform === "linux" ? `/proc/${process.pid}/fd/${folder.fd}` : root;
    if (await realpath(openedPath) !== root) throw new Error("主题文件夹路径已变化。");
    return await action(openedPath);
  } finally {
    await folder.close();
  }
}

async function readGrants(path: string) {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new Error("主题授权记录不是普通文件。");
      const contents = await file.readFile("utf8");
      let data: unknown;
      try {
        data = JSON.parse(contents);
      } catch (error) {
        if (error instanceof SyntaxError) return null;
        throw error;
      }
      if (!Array.isArray(data) || data.some((entry) => typeof entry !== "string" || !isAbsolute(entry) || entry.includes("\0"))) {
        return null;
      }
      return new Set<string>(data);
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return new Set<string>();
  }
}

export function createElectronThemes(userData: string) {
  const defaultDirectory = join(userData, "themes");
  const grantsPath = join(userData, "theme-access.json");
  let grants: ReturnType<typeof readGrants> | undefined;
  let writes = Promise.resolve();
  const getGrants = () => grants ??= readGrants(grantsPath);

  async function inDirectory<T>(
    directory: string | null | undefined,
    action: (root: string, openedPath: string) => Promise<T>
  ) {
    const root = directory ?? defaultDirectory;
    if (root === defaultDirectory) await mkdir(root, { mode: 0o700, recursive: true });
    else {
      const authorized = await getGrants();
      if (!authorized) throw new Error("主题文件夹授权记录损坏，请重新选择文件夹。");
      if (!authorized.has(root)) throw new Error("主题文件夹尚未通过选择对话框授权。");
    }

    return useDirectory(root, (openedPath) => action(root, openedPath));
  }

  return {
    async authorizeDirectory(path: string) {
      const root = await realpath(path);
      await useDirectory(root, async () => undefined);
      const save = async () => {
        const authorized = await getGrants();
        if (authorized?.has(root)) return;
        // A damaged record never grants access; a fresh picker confirmation can replace it.
        const updated = [...(authorized ?? []), root];
        await atomicWrite(grantsPath, JSON.stringify(updated), 0o600);
        grants = Promise.resolve(new Set(updated));
      };
      writes = writes.then(save, save);
      await writes;
      return root;
    },
    list: (directory?: string | null) => inDirectory(directory, async (root, openedPath) => {
      const entries = await readdir(openedPath, { withFileTypes: true });
      const files = entries.filter((entry) => entry.isFile() && isThemeCssFileName(entry.name)).map((entry) => entry.name);
      files.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b));
      return { directory: root, files };
    }),
    read: (name: string, directory?: string | null) => inDirectory(directory, async (_root, openedPath) => {
      if (!isThemeCssFileName(name)) throw new Error("请选择主题文件夹中的 CSS 文件。");
      const file = await open(join(openedPath, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > maxThemeCssBytes) throw new Error("主题必须为不超过 1 MiB 的普通 CSS 文件。");
        const bytes = Buffer.allocUnsafe(maxThemeCssBytes + 1);
        let length = 0;
        while (length < bytes.length) {
          const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > maxThemeCssBytes) throw new Error("主题文件超过 1 MiB。");
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
      } finally {
        await file.close();
      }
    }),
    openFolder: (directory?: string | null) => inDirectory(directory, (_root, openedPath) => new Promise<undefined>((resolve, reject) => {
      const opener = process.platform === "darwin" ? "/usr/bin/open" : "/usr/bin/xdg-open";
      const env = { ...process.env, PATH: "/usr/local/bin:/usr/bin:/bin" };
      execFile(opener, ["."], { cwd: openedPath, env }, (error) => {
        if (error) reject(error);
        else resolve(undefined);
      });
    }))
  };
}
