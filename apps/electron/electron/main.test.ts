import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { app, BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => ({
  userDataPath: "",
  selectedFile: null as string | null,
  openFolder: vi.fn<(opener: string, directory: string) => unknown>(),
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}));

vi.mock("node:child_process", async (importOriginal) => {
  const childProcess = await importOriginal<typeof import("node:child_process")>();
  const open = vi.fn((opener: string, args: string[], options: { cwd: string }, callback: (error: Error | null) => unknown) => {
    realpath(resolve(options.cwd, args[0])).then((path) => {
      shell.openFolder(opener, path);
      callback(null);
    }, callback);
  });
  return { ...childProcess, default: { ...childProcess, execFile: open }, execFile: open };
});

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const windows: Window[] = [];
  let nextId = 0;
  class Window extends EventEmitter {
    destroyed = false;
    url = "";
    webContents = Object.assign(new EventEmitter(), {
      id: ++nextId,
      mainFrame: { url: "" },
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      getURL: () => this.url
    });

    constructor() {
      super();
      windows.push(this);
    }

    static getAllWindows() { return windows.filter((window) => !window.destroyed); }
    static getFocusedWindow() { return Window.getAllWindows()[0] ?? null; }
    isDestroyed() { return this.destroyed; }
    loadURL(url: string) {
      this.url = url;
      this.webContents.mainFrame.url = url;
      return Promise.resolve();
    }
    show() {}
    focus() {}
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("closed");
    }
  }

  return {
    app: Object.assign(new EventEmitter(), {
      isPackaged: true,
      setName: vi.fn(),
      enableSandbox: vi.fn(),
      requestSingleInstanceLock: () => true,
      whenReady: async () => undefined,
      getPath: () => shell.userDataPath,
      quit: vi.fn(),
      exit: vi.fn()
    }),
    BrowserWindow: Window,
    clipboard: { readText: () => "" },
    dialog: {
      showErrorBox: vi.fn(),
      showOpenDialog: async () => ({
        canceled: shell.selectedFile === null,
        filePaths: shell.selectedFile ? [shell.selectedFile] : []
      })
    },
    ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => shell.handlers.set(name, handler) },
    Menu: { setApplicationMenu: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    session: {
      defaultSession: {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        webRequest: { onBeforeRequest: vi.fn() }
      },
      fromPartition: () => ({ fetch: vi.fn() })
    }
  };
});

let directory: string;
let originalArgv: string[];

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  app.removeAllListeners();
  shell.handlers.clear();
  directory = await mkdtemp(join(await realpath(tmpdir()), "markra-main-"));
  shell.userDataPath = join(directory, "settings");
  shell.selectedFile = null;
  originalArgv = process.argv;
  process.argv = ["electron"];
});

afterEach(async () => {
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  process.argv = originalArgv;
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function start() {
  await import("./main");
  await expect.poll(() => BrowserWindow.getAllWindows().length).toBe(1);
}

async function invoke(window: BrowserWindow, name: string, ...args: unknown[]) {
  const handler = shell.handlers.get(name);
  if (!handler) throw new Error(`Missing IPC handler: ${name}`);
  return handler({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args);
}

describe("Electron main process", () => {
  it("restores a picked theme directory without granting access to other directories or documents", async () => {
    const selected = join(directory, "themes");
    const other = join(directory, "other");
    await Promise.all([mkdir(selected), mkdir(other)]);
    const css = ":root { --paper: #fff; }";
    await Promise.all([
      writeFile(join(selected, "light.CSS"), css),
      writeFile(join(selected, "notes.md"), "private notes"),
      writeFile(join(other, "light.CSS"), "private CSS")
    ]);
    await start();
    const first = BrowserWindow.getAllWindows()[0];
    await expect(invoke(first, "markra:theme-list", selected)).rejects.toThrow();
    await expect(invoke(first, "markra:theme-choose", { title: "Choose theme folder" })).resolves.toBeNull();
    shell.selectedFile = selected;
    await expect(invoke(first, "markra:theme-choose", { title: "Choose theme folder" })).resolves.toBe(selected);
    await expect(invoke(first, "markra:theme-list", selected)).resolves.toEqual({ directory: selected, files: ["light.CSS"] });
    await expect(invoke(first, "markra:theme-read", "light.CSS", other)).rejects.toThrow();
    await expect(invoke(first, "markra:theme-open", other)).rejects.toThrow();
    await expect(invoke(first, "markra:file-read", join(selected, "notes.md"))).rejects.toThrow();

    first.destroy();
    app.removeAllListeners();
    shell.handlers.clear();
    vi.resetModules();
    await start();
    const restarted = BrowserWindow.getAllWindows()[0];
    await expect(invoke(restarted, "markra:theme-read", "light.CSS", selected)).resolves.toBe(css);
  });

  it("opens the selected theme folder in the system file manager", async () => {
    const selected = join(directory, "local themes");
    await mkdir(selected);
    await start();
    const window = BrowserWindow.getAllWindows()[0];
    shell.selectedFile = selected;
    await expect(invoke(window, "markra:theme-choose", { title: "Choose theme folder" })).resolves.toBe(selected);
    await expect(invoke(window, "markra:theme-open", selected)).resolves.toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(shell.openFolder).toHaveBeenCalledExactlyOnceWith(
      process.platform === "darwin" ? "/usr/bin/open" : "/usr/bin/xdg-open", selected
    );
  });

  it.each(["{broken", JSON.stringify([false])])("recovers theme access after choosing a folder with a damaged record: %s", async (invalidGrants) => {
    await mkdir(shell.userDataPath);
    const grantsPath = join(shell.userDataPath, "theme-access.json");
    await writeFile(grantsPath, invalidGrants);
    const folder = join(directory, "themes");
    await mkdir(folder);
    const css = ":root { --paper: #111; }";
    await writeFile(join(folder, "dark.css"), css);
    const path = join(directory, "note.md");
    await writeFile(path, "# Still editable");
    await start();
    const window = BrowserWindow.getAllWindows()[0];
    await expect(invoke(window, "markra:theme-list", folder)).rejects.toThrow();
    await expect(invoke(window, "markra:theme-list")).resolves.toMatchObject({ files: [] });
    await expect(readFile(grantsPath, "utf8")).resolves.toBe(invalidGrants);
    shell.selectedFile = path;
    await invoke(window, "markra:file-open");
    await expect(invoke(window, "markra:file-read", path)).resolves.toMatchObject({ content: "# Still editable" });

    shell.selectedFile = folder;
    await expect(invoke(window, "markra:theme-choose", { title: "Choose theme folder" })).resolves.toBe(folder);
    await expect(invoke(window, "markra:theme-read", "dark.css", folder)).resolves.toBe(css);
    await expect(invoke(window, "markra:theme-list", directory)).rejects.toThrow();

    window.destroy();
    app.removeAllListeners();
    shell.handlers.clear();
    vi.resetModules();
    await start();
    const restarted = BrowserWindow.getAllWindows()[0];
    await expect(invoke(restarted, "markra:theme-read", "dark.css", folder)).resolves.toBe(css);
  });

  it("lists only direct CSS files and rejects invalid, missing or replaced files and folders without writing to them", async () => {
    const selected = join(directory, "themes");
    const elsewhere = join(directory, "elsewhere");
    await Promise.all([mkdir(elsewhere), mkdir(join(selected, "nested.css"), { recursive: true })]);
    const valid = join(selected, "dark.css");
    const css = "/* 本地主题 */";
    await Promise.all([
      writeFile(valid, css),
      writeFile(join(selected, "invalid.css"), new Uint8Array([0xff])),
      writeFile(join(selected, "large.css"), Buffer.alloc(1024 * 1024 + 1)),
      writeFile(join(selected, "nested.css", "child.css"), css),
      writeFile(join(elsewhere, "dark.css"), "outside the selected folder"),
      symlink(join(elsewhere, "dark.css"), join(selected, "link.css"))
    ]);
    await start();
    const window = BrowserWindow.getAllWindows()[0];
    const defaults = await invoke(window, "markra:theme-list");
    expect(defaults).toEqual({ directory: join(shell.userDataPath, "themes"), files: [] });
    shell.selectedFile = selected;
    await invoke(window, "markra:theme-choose", { title: "Choose theme folder" });
    await expect(invoke(window, "markra:theme-list", selected)).resolves.toEqual({
      directory: selected, files: ["dark.css", "invalid.css", "large.css"]
    });
    for (const name of ["../elsewhere/dark.css", "invalid.css", "large.css", "link.css", "nested.css", "missing.css"]) {
      await expect(invoke(window, "markra:theme-read", name, selected)).rejects.toThrow();
    }
    await expect(invoke(window, "markra:theme-read", "dark.css", selected)).resolves.toBe(css);
    await expect(readFile(valid, "utf8")).resolves.toBe(css);

    await rm(selected, { recursive: true });
    await symlink(elsewhere, selected);
    await expect(invoke(window, "markra:theme-list", selected)).rejects.toThrow();
    await expect(invoke(window, "markra:theme-read", "dark.css", selected)).rejects.toThrow();
  });

  it("opens a second instance's relative file from that instance's working directory", async () => {
    const firstDirectory = join(directory, "first");
    const secondDirectory = join(directory, "second");
    await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory)]);
    await Promise.all([
      writeFile(join(firstDirectory, "note.md"), "first window"),
      writeFile(join(secondDirectory, "note.md"), "second window")
    ]);
    vi.spyOn(process, "cwd").mockReturnValue(firstDirectory);
    await start();

    app.emit("second-instance", {}, ["electron", "note.md"], secondDirectory, {});
    await expect.poll(() => BrowserWindow.getAllWindows().length).toBe(2);
    const openedUrl = new URL(BrowserWindow.getAllWindows()[1].webContents.getURL());
    expect(openedUrl.searchParams.get("path")).toBe(join(secondDirectory, "note.md"));
  });

  it.each(["unsubscribe", "close", "reload", "crash", "close-during-setup"])(
    "keeps another window's file watch alive after %s",
    async (action) => {
      const path = join(directory, "shared.md");
      await writeFile(path, "initial");
      shell.selectedFile = path;
      await start();
      const first = BrowserWindow.getAllWindows()[0];
      await invoke(first, "markra:file-open");
      await invoke(first, "markra:editor-open", path);
      const second = BrowserWindow.getAllWindows()[1];
      await invoke(second, "markra:watch-start", 1, "file", path);
      const pending = invoke(first, "markra:watch-start", 1, "file", path);
      if (action === "close-during-setup") first.destroy();
      await pending;
      if (action === "unsubscribe") await invoke(first, "markra:watch-stop", 1);
      if (action === "close") first.destroy();
      if (action === "reload") first.webContents.emit("did-navigate", {}, "markra://app/index.html", 200, "OK");
      if (action === "crash") first.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
      vi.mocked(first.webContents.send).mockClear();
      vi.mocked(second.webContents.send).mockClear();

      await invoke(second, "markra:file-save", { path, contents: "saved in another window", suggestedName: "shared.md" });
      await expect.poll(() => vi.mocked(second.webContents.send).mock.calls.some(([, name, payload]) =>
        name === "markra:watch-1" && payload.kind === "file" && payload.path === path
      )).toBe(true);
      expect(first.webContents.send).not.toHaveBeenCalled();
      const loaded = await invoke(second, "markra:file-read", path);
      expect(loaded).toMatchObject({ content: "saved in another window" });
    }
  );

  it("rejects ungranted paths, duplicate watch IDs and requests from a different frame", async () => {
    const path = join(directory, "private.md");
    await writeFile(path, "private");
    await start();
    const window = BrowserWindow.getAllWindows()[0];
    await expect(invoke(window, "markra:watch-start", 1, "file", path)).rejects.toThrow();
    shell.selectedFile = path;
    await invoke(window, "markra:file-open");
    await invoke(window, "markra:watch-start", 1, "file", path);
    await expect(invoke(window, "markra:watch-start", 1, "file", path)).rejects.toThrow();
    expect(() => shell.handlers.get("markra:watch-stop")?.({
      sender: window.webContents,
      senderFrame: { url: "markra://app/index.html" }
    }, 1)).toThrow();
    await expect(invoke(window, "markra:event-emit", "markra:watch-1", { kind: "file", path })).rejects.toThrow();
  });


  it("keeps file notifications when a page navigation is blocked", async () => {
    const path = join(directory, "selected.md");
    await writeFile(path, "initial");
    shell.selectedFile = path;
    await start();
    const window = BrowserWindow.getAllWindows()[0];
    await invoke(window, "markra:file-open");
    await invoke(window, "markra:watch-start", 1, "file", path);
    const preventDefault = vi.fn();
    window.webContents.emit("did-start-navigation", {}, "https://example.com", false, true);
    window.webContents.emit("will-navigate", { preventDefault }, "https://example.com");
    expect(preventDefault).toHaveBeenCalled();
    await writeFile(path, "external update");
    await expect.poll(() => vi.mocked(window.webContents.send).mock.calls.some(([, name, payload]) =>
      name === "markra:watch-1" && payload.kind === "file" && payload.path === path
    )).toBe(true);
  });

});

