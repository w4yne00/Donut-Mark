import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ElectronSettings } from "./bridge";
import { atomicWrite } from "./atomic-write";

type Store = {
  autoSave: boolean;
  values: Map<string, unknown>;
  writes: Promise<unknown>;
};

function storeName(path: string) {
  if (path !== "settings.json" && !/^ai-agent-sessions\/[a-z\d-]+\.json$/iu.test(path)) {
    throw new Error("不允许访问此设置文件。");
  }
  return path;
}

function copyValue(value: unknown) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("设置值必须可保存为 JSON。");
  return JSON.parse(serialized) as unknown;
}

export function createElectronSettings(userDataPath: string): ElectronSettings {
  const root = resolve(userDataPath);
  const stores = new Map<string, Promise<Store>>();

  async function prepareDirectory(path: string) {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await realpath(directory) !== directory) throw new Error("设置目录不允许包含符号链接。");
  }

  async function readStore(name: string): Promise<Store> {
    const path = join(root, name);
    await prepareDirectory(path);
    let values: Record<string, unknown> = {};
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await file.stat()).isFile()) throw new Error("设置必须保存为普通文件。");
        const parsed: unknown = JSON.parse(await file.readFile("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("设置文件格式无效。");
        values = parsed as Record<string, unknown>;
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { values: new Map(Object.entries(values)), autoSave: false, writes: Promise.resolve() };
  }

  function getStore(path: string) {
    const name = storeName(path);
    let store = stores.get(name);
    if (!store) {
      store = readStore(name);
      stores.set(name, store);
    }
    return store;
  }

  async function writeStore(path: string, contents: string) {
    await prepareDirectory(path);
    try {
      const existing = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
      try {
        if (!(await existing.stat()).isFile()) throw new Error("设置必须保存为普通文件。");
      } finally {
        await existing.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await atomicWrite(path, contents, 0o600);
  }

  async function save(path: string) {
    const store = await getStore(path);
    const contents = JSON.stringify(Object.fromEntries(store.values));
    const write = () => writeStore(join(root, storeName(path)), contents);
    store.writes = store.writes.then(write, write);
    return store.writes;
  }

  return {
    async load(path, options) {
      if (!options || typeof options.autoSave !== "boolean" || !options.defaults ||
        typeof options.defaults !== "object" || Array.isArray(options.defaults)) {
        throw new Error("设置加载参数无效。");
      }
      const store = await getStore(path);
      for (const [key, value] of Object.entries(options.defaults)) {
        if (!store.values.has(key)) store.values.set(key, copyValue(value));
      }
      store.autoSave ||= options.autoSave;
    },
    async get(path, key) {
      const value = (await getStore(path)).values.get(key);
      return value === undefined ? undefined : copyValue(value);
    },
    async set(path, key, value) {
      if (typeof key !== "string") throw new Error("设置键必须为文本。");
      const store = await getStore(path);
      store.values.set(key, copyValue(value));
      if (store.autoSave) await save(path);
    },
    async delete(path, key) {
      const store = await getStore(path);
      store.values.delete(key);
      if (store.autoSave) await save(path);
    },
    save
  };
}
