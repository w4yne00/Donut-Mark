import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, session } from "electron";
import { dirname, join, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { NativeAiChatRequest, NativeEditorWindowRestoreState, NativeSettingsWindowTarget, SetNativeEditorWindowRestoreStateInput } from "@markra/app/runtime";
import { settingsEvents, type ElectronBridge } from "./bridge";
import { createElectronAi } from "./ai";
import { createElectronFiles } from "./files";
import { createElectronSettings } from "./settings";
import { createElectronThemes } from "./themes";

const appUrl = "markra://app/index.html";
const bundleDirectory = dirname(fileURLToPath(import.meta.url));
const rendererDirectory = resolve(bundleDirectory, "../dist");
const windows = new Map<number, { window: BrowserWindow; settings: boolean; watches: Map<number, () => unknown>; aiRequests: Map<number, AbortController>; restore?: NativeEditorWindowRestoreState }>();
let fileService: Awaited<ReturnType<typeof createElectronFiles>>;
let quitting = false;
let exitRestoreStates: NativeEditorWindowRestoreState[] | null = null;

app.setName("Donut Mark");
app.enableSandbox();
protocol.registerSchemesAsPrivileged([{ scheme: "markra", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

function reportError(error: unknown) {
  dialog.showErrorBox("Donut Mark", error instanceof Error ? error.message : String(error));
}

function isAppPage(value: string) {
  const url = new URL(value);
  return url.protocol === "markra:" && url.host === "app" && url.pathname === "/index.html";
}

function register<TArgs extends unknown[]>(name: string, handler: (window: BrowserWindow, ...args: TArgs) => unknown) {
  ipcMain.handle(name, (event, ...args) => {
    const window = windows.get(event.sender.id)?.window;
    if (!window || event.senderFrame !== event.sender.mainFrame || !isAppPage(event.senderFrame.url)) {
      throw new Error("拒绝来自未授权页面的请求。");
    }
    return handler(window, ...(args as TArgs));
  });
}

function emit(window: BrowserWindow, name: string, payload?: unknown) {
  window.webContents.send("markra:event", name, payload);
}

function requestExit() {
  // Every editor persists the same snapshot even if another window finishes first.
  exitRestoreStates = [...windows.values()].flatMap((state) => state.restore ? [state.restore] : []);
  for (const state of windows.values()) {
    if (state.settings) state.window.close();
    else emit(state.window, "markra:app-exit-request");
  }
}

function createWindow({ settings = false, path, target, blank = false }: {
  settings?: boolean;
  path?: string;
  target?: NativeSettingsWindowTarget;
  blank?: boolean;
} = {}) {
  const window = new BrowserWindow({
    width: settings ? 960 : 1200,
    height: 820,
    minWidth: 760,
    minHeight: 540,
    show: false,
    title: "Donut Mark",
    backgroundColor: "#ffffff",
    icon: join(rendererDirectory, "icons/donut-mark-32.png"),
    webPreferences: {
      preload: join(bundleDirectory, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  });
  const id = window.webContents.id;
  const watches = new Map<number, () => unknown>();
  const aiRequests = new Map<number, AbortController>();
  const stopWindowTasks = () => {
    for (const stop of watches.values()) stop();
    watches.clear();
    for (const request of aiRequests.values()) request.abort();
    aiRequests.clear();
  };
  windows.set(id, { window, settings, watches, aiRequests });
  window.webContents.on("did-navigate", stopWindowTasks);
  window.webContents.on("render-process-gone", stopWindowTasks);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.on("close", (event) => {
    if (!settings && !quitting) {
      event.preventDefault();
      emit(window, "markra:close-request");
    }
  });
  window.on("closed", () => {
    stopWindowTasks();
    windows.delete(id);
    if (![...windows.values()].some((state) => !state.settings)) {
      for (const state of windows.values()) state.window.destroy();
    }
  });
  window.once("ready-to-show", () => window.show());
  const url = new URL(appUrl);
  if (settings) url.searchParams.set("settings", "1");
  if (target) url.searchParams.set("settingsTarget", target);
  if (blank) url.searchParams.set("blank", "1");
  if (path) url.searchParams.set("path", path);
  window.loadURL(url.href).catch((error) => {
    reportError(error);
    window.destroy();
  });
  return window;
}

async function openArguments(argv: string[], workingDirectory = process.cwd()) {
  const paths: string[] = [];
  for (const argument of argv) {
    if (argument.startsWith("-") || !/\.(?:md|markdown|mdown|mkd|txt)$/i.test(argument)) continue;
    paths.push(await fileService.authorizeFile(resolve(workingDirectory, argument)));
  }
  return paths;
}

async function start() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    const allowed = (url.protocol === "markra:" && url.host === "app") || url.protocol === "data:" || url.protocol === "blob:";
    callback({ cancel: !allowed });
  });
  // Only the main process can fetch these bundled files. Renderer file:// requests stay blocked.
  const assets = session.fromPartition("markra-assets");
  protocol.handle("markra", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "app") return new Response("Forbidden", { status: 403 });
    try {
      const path = await realpath(resolve(rendererDirectory, "." + decodeURIComponent(url.pathname)));
      if (!path.startsWith(rendererDirectory + sep)) return new Response("Forbidden", { status: 403 });
      return assets.fetch(pathToFileURL(path).href);
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  const focusedWindow = () => BrowserWindow.getFocusedWindow() ?? [...windows.values()][0]?.window;
  const markdownFilters = [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "txt"] }];
  fileService = await createElectronFiles({
    userDataPath: app.getPath("userData"),
    onWatchError: reportError,
    chooseFile: async (labels) => {
      const result = await dialog.showOpenDialog(focusedWindow(), {
        title: labels?.title ?? "打开 Markdown 文件",
        filters: markdownFilters,
        properties: ["openFile"]
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    chooseFolder: async (labels) => {
      const result = await dialog.showOpenDialog(focusedWindow(), {
        title: labels?.title ?? "打开文件夹",
        properties: ["openDirectory"]
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    chooseSavePath: async (input) => {
      const result = await dialog.showSaveDialog(focusedWindow(), {
        title: "保存 Markdown 文件",
        defaultPath: join(input.defaultDirectory ?? app.getPath("documents"), input.suggestedName),
        filters: markdownFilters
      });
      return result.canceled ? null : result.filePath ?? null;
    }
  });
  const files = fileService.files;
  const stores = createElectronSettings(app.getPath("userData"));
  const ai = createElectronAi(app.getPath("userData"));
  const themes = createElectronThemes(await realpath(app.getPath("userData")));
  register("markra:theme-list", (_window, directory?: string | null) => themes.list(directory));
  register("markra:theme-read", (_window, name: string, directory?: string | null) => themes.read(name, directory));
  register("markra:theme-open", (_window, directory?: string | null) => themes.openFolder(directory));
  register("markra:theme-choose", async (window, options: Parameters<ElectronBridge["themes"]["chooseFolder"]>[0]) => {
    const result = await dialog.showOpenDialog(window, {
      title: typeof options?.title === "string" ? options.title : "选择主题文件夹",
      defaultPath: typeof options?.defaultPath === "string" ? options.defaultPath : undefined,
      properties: ["openDirectory"]
    });
    const path = result.canceled ? undefined : result.filePaths[0];
    return path ? themes.authorizeDirectory(path) : null;
  });
  register("markra:file-open", (_window, ...args: Parameters<typeof files.openMarkdownFile>) => files.openMarkdownFile(...args));
  register("markra:path-open", (_window, ...args: Parameters<typeof files.openMarkdownPath>) => files.openMarkdownPath(...args));
  register("markra:folder-open", (_window, ...args: Parameters<typeof files.openMarkdownFolder>) => files.openMarkdownFolder(...args));
  register("markra:file-read", (_window, ...args: Parameters<typeof files.readMarkdownFile>) => files.readMarkdownFile(...args));
  register("markra:file-save", (_window, ...args: Parameters<typeof files.saveMarkdownFile>) => files.saveMarkdownFile(...args));
  register("markra:path-resolve", (_window, ...args: Parameters<typeof files.resolveMarkdownPath>) => files.resolveMarkdownPath(...args));
  register("markra:files-list", (_window, ...args: Parameters<typeof files.listMarkdownFilesForPath>) => files.listMarkdownFilesForPath(...args));
  register("markra:image-read", (_window, ...args: Parameters<typeof files.readMarkdownImageFile>) => files.readMarkdownImageFile(...args));
  register("markra:watch-start", async (window, id: number, kind: "file" | "tree", path: string) => {
    const watches = windows.get(window.webContents.id)!.watches;
    if (!Number.isSafeInteger(id) || id < 1 || watches.has(id) || (kind !== "file" && kind !== "tree")) {
      throw new Error("无效的文件监听请求。");
    }
    let active = true;
    let stop: (() => unknown) | undefined;
    const cleanup = () => {
      active = false;
      stop?.();
    };
    watches.set(id, cleanup);
    const notify = (eventKind: "file" | "tree", changedPath: string) => {
      if (active) emit(window, `markra:watch-${id}`, { kind: eventKind, path: changedPath });
    };
    try {
      stop = kind === "file"
        ? await files.watchMarkdownFile(path, (changedPath) => notify("file", changedPath), (root) => notify("tree", root))
        : await files.watchMarkdownTree(path, (root) => notify("tree", root));
      if (!active) stop();
    } catch (error) {
      if (watches.get(id) === cleanup) watches.delete(id);
      throw error;
    }
  });
  register("markra:watch-stop", (window, id: number) => {
    const watches = windows.get(window.webContents.id)!.watches;
    watches.get(id)?.();
    watches.delete(id);
  });
  register("markra:store-load", (_window, ...args: Parameters<typeof stores.load>) => stores.load(...args));
  register("markra:store-get", (_window, ...args: Parameters<typeof stores.get>) => stores.get(...args));
  register("markra:store-set", (_window, ...args: Parameters<typeof stores.set>) => stores.set(...args));
  register("markra:store-delete", (_window, ...args: Parameters<typeof stores.delete>) => stores.delete(...args));
  register("markra:store-save", (_window, ...args: Parameters<typeof stores.save>) => stores.save(...args));
  register("markra:ai-config", async (window) => {
    const config = await ai.getConfig();
    return windows.get(window.webContents.id)?.settings ? config : { ...config, apiKey: "" };
  });
  register("markra:ai-config-save", async (window, config: unknown) => {
    if (!windows.get(window.webContents.id)?.settings) throw new Error("只能从设置窗口修改内网 AI 配置。");
    const saved = await ai.saveConfig(config);
    for (const state of windows.values()) emit(state.window, "markra://intranet-ai-config-changed");
    return saved;
  });
  register("markra:ai-chat", async (window, id: number, input: NativeAiChatRequest, stream: boolean) => {
    const { aiRequests } = windows.get(window.webContents.id)!;
    if (!Number.isSafeInteger(id) || id < 1 || aiRequests.has(id) || typeof stream !== "boolean") {
      throw new Error("内网 AI 请求编号或类型无效。");
    }
    const controller = new AbortController();
    aiRequests.set(id, controller);
    try {
      return await ai.request(input, controller.signal, stream ? (chunk) => emit(window, `markra:ai-chunk-${id}`, chunk) : undefined);
    } catch (error) {
      if (controller.signal.aborted) return { status: 499 };
      throw error;
    } finally {
      if (aiRequests.get(id) === controller) aiRequests.delete(id);
    }
  });
  register("markra:ai-stop", (window, id: number) => {
    windows.get(window.webContents.id)?.aiRequests.get(id)?.abort();
  });
  register("markra:confirm-discard", async (window, name: string, labels: Parameters<ElectronBridge["confirmDiscard"]>[1]) => {
    const result = await dialog.showMessageBox(window, {
      type: "warning",
      message: labels.message,
      detail: name,
      buttons: [labels.cancelLabel, labels.okLabel],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    return result.response === 1;
  });
  // Launch paths are passed to individual windows in their URL, never replayed as a queue.
  register("markra:opened-paths", () => []);
  register("markra:editor-open", async (_window, path?: string) => {
    if (path) await files.readMarkdownFile(path);
    createWindow({ path, blank: !path });
  });
  register("markra:settings-open", (_window, target?: NativeSettingsWindowTarget) => {
    if (target !== undefined && target !== "exportPandocPath") throw new Error("无效的设置目标。");
    const existing = [...windows.values()].find((state) => state.settings)?.window;
    if (existing) {
      existing.show();
      existing.focus();
      if (target) emit(existing, "markra:settings-target", target);
    } else createWindow({ settings: true, target });
  });
  register("markra:window-action", (window, action: Parameters<ElectronBridge["windowAction"]>[0]) => {
    switch (action) {
      case "close": return window.close();
      case "destroy": return window.destroy();
      case "minimize": return window.minimize();
      case "maximize": return window.isMaximized() ? window.unmaximize() : window.maximize();
      case "fullscreen": return window.setFullScreen(!window.isFullScreen());
      case "show": return window.show();
      default: throw new Error("无效的窗口操作。");
    }
  });
  register("markra:window-label", (window) => `electron-${window.webContents.id}`);
  register("markra:window-title", (window, title: string) => {
    if (typeof title !== "string") throw new Error("无效的窗口标题。");
    window.setTitle(title);
  });
  register("markra:window-zoom", (window, factor: number) => {
    if (!Number.isFinite(factor) || factor < 0.5 || factor > 3) throw new Error("无效的缩放比例。");
    window.webContents.setZoomFactor(factor);
  });
  register("markra:restore-list", () => exitRestoreStates ?? [...windows.values()].flatMap((state) => state.restore ? [state.restore] : []));
  register("markra:restore-set", (window, state: SetNativeEditorWindowRestoreStateInput) => {
    if (!state || (state.filePath !== null && typeof state.filePath !== "string") ||
      !Array.isArray(state.openFilePaths) || !state.openFilePaths.every((path) => typeof path === "string")) {
      throw new Error("无效的窗口恢复信息。");
    }
    windows.get(window.webContents.id)!.restore = { ...state, label: `electron-${window.webContents.id}` };
  });
  register("markra:exit-request", requestExit);
  register("markra:exit-finish", (window) => window.destroy());
  register("markra:clipboard-read", () => clipboard.readText());
  register("markra:event-emit", (_window, name: string, payload: unknown) => {
    if (!settingsEvents.has(name)) throw new Error("不允许广播此事件。");
    for (const state of windows.values()) emit(state.window, name, payload);
  });
  app.on("second-instance", (_event, argv, workingDirectory) => {
    openArguments(argv.slice(1), workingDirectory).then((paths) => {
      if (paths.length === 0) createWindow({ blank: true });
      else paths.forEach((path) => createWindow({ path }));
    }).catch(reportError);
  });
  app.on("before-quit", (event) => {
    if (quitting || windows.size === 0) return;
    event.preventDefault();
    requestExit();
  });
  app.on("window-all-closed", () => {
    quitting = true;
    app.quit();
  });
  const paths = await openArguments(process.argv.slice(app.isPackaged ? 1 : 2));
  if (paths.length === 0) createWindow();
  else paths.forEach((path) => createWindow({ path }));
}

start().catch((error) => {
  reportError(error);
  app.exit(1);
});
