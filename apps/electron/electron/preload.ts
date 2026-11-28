import { contextBridge, ipcRenderer } from "electron";
import type { ElectronBridge, ElectronFileWatchEvent } from "./bridge";

let nextWatchId = 0;
const eventListeners = new Set<(name: string, payload: unknown) => unknown>();

function dispatchEvent(_event: Electron.IpcRendererEvent, name: string, payload: unknown) {
  // Match EventEmitter delivery when a callback subscribes or unsubscribes mid-event.
  for (const listener of [...eventListeners]) listener(name, payload);
}

function onEvent(handler: (name: string, payload: unknown) => unknown) {
  // Each subscription owns its cleanup, even when callers reuse the same callback.
  const listener = (name: string, payload: unknown) => handler(name, payload);
  eventListeners.add(listener);
  if (eventListeners.size === 1) ipcRenderer.on("markra:event", dispatchEvent);
  return () => {
    eventListeners.delete(listener);
    if (eventListeners.size === 0) ipcRenderer.removeListener("markra:event", dispatchEvent);
  };
}

async function watchPath(kind: "file" | "tree", path: string, onChange: (event: ElectronFileWatchEvent) => unknown) {
  const id = ++nextWatchId;
  const eventName = `markra:watch-${id}`;
  const stopListening = onEvent((name, payload) => {
    if (name === eventName) onChange(payload as ElectronFileWatchEvent);
  });
  try {
    await ipcRenderer.invoke("markra:watch-start", id, kind, path);
  } catch (error) {
    stopListening();
    throw error;
  }
  return () => {
    stopListening();
    return ipcRenderer.invoke("markra:watch-stop", id).catch(console.error);
  };
}

const bridge: ElectronBridge = {
  ai: {
    getConfig: () => ipcRenderer.invoke("markra:ai-config"),
    saveConfig: (config) => ipcRenderer.invoke("markra:ai-config-save", config),
    async chat(id, { body, url }, onChunk) {
      const stopListening = onChunk ? onEvent((name, payload) => {
        if (name === `markra:ai-chunk-${id}` && typeof payload === "string") onChunk?.(payload);
      }) : undefined;
      try {
        return await ipcRenderer.invoke("markra:ai-chat", id, { body, url }, Boolean(onChunk));
      } finally {
        stopListening?.();
      }
    },
    stop: (id) => ipcRenderer.invoke("markra:ai-stop", id)
  },
  files: {
    openMarkdownFile: (labels) => ipcRenderer.invoke("markra:file-open", labels),
    openMarkdownPath: (labels) => ipcRenderer.invoke("markra:path-open", labels),
    openMarkdownFolder: (labels) => ipcRenderer.invoke("markra:folder-open", labels),
    readMarkdownFile: (path) => ipcRenderer.invoke("markra:file-read", path),
    saveMarkdownFile: (input) => ipcRenderer.invoke("markra:file-save", input),
    resolveMarkdownPath: (path) => ipcRenderer.invoke("markra:path-resolve", path),
    listMarkdownFilesForPath: (path, options) => ipcRenderer.invoke("markra:files-list", path, options),
    readMarkdownImageFile: (input) => ipcRenderer.invoke("markra:image-read", input),
    watchMarkdownFile: (path, onChange, onTreeChange) => watchPath("file", path, (event) => {
      if (event.kind === "file") onChange(event.path);
      else onTreeChange?.(event.path);
    }),
    watchMarkdownTree: (path, onTreeChange) => watchPath("tree", path, (event) => onTreeChange(event.path))
  },
  themes: {
    list: (directory) => ipcRenderer.invoke("markra:theme-list", directory),
    read: (name, directory) => ipcRenderer.invoke("markra:theme-read", name, directory),
    openFolder: (directory) => ipcRenderer.invoke("markra:theme-open", directory),
    chooseFolder: (options) => ipcRenderer.invoke("markra:theme-choose", options)
  },
  settings: {
    load: (path, options) => ipcRenderer.invoke("markra:store-load", path, options),
    get: (path, key) => ipcRenderer.invoke("markra:store-get", path, key),
    set: (path, key, value) => ipcRenderer.invoke("markra:store-set", path, key, value),
    delete: (path, key) => ipcRenderer.invoke("markra:store-delete", path, key),
    save: (path) => ipcRenderer.invoke("markra:store-save", path)
  },
  confirmDiscard: (name, labels) => ipcRenderer.invoke("markra:confirm-discard", name, labels),
  takeOpenedPaths: () => ipcRenderer.invoke("markra:opened-paths"),
  openEditor: (path) => ipcRenderer.invoke("markra:editor-open", path),
  openSettings: (target) => ipcRenderer.invoke("markra:settings-open", target),
  windowAction: (action) => ipcRenderer.invoke("markra:window-action", action),
  windowLabel: () => ipcRenderer.invoke("markra:window-label"),
  setTitle: (title) => ipcRenderer.invoke("markra:window-title", title),
  setZoom: (factor) => ipcRenderer.invoke("markra:window-zoom", factor),
  listRestoreStates: () => ipcRenderer.invoke("markra:restore-list"),
  setRestoreState: (state) => ipcRenderer.invoke("markra:restore-set", state),
  requestExit: () => ipcRenderer.invoke("markra:exit-request"),
  finishExit: () => ipcRenderer.invoke("markra:exit-finish"),
  readClipboardText: () => ipcRenderer.invoke("markra:clipboard-read"),
  emit: (name, payload) => ipcRenderer.invoke("markra:event-emit", name, payload),
  onEvent
};

contextBridge.exposeInMainWorld("markra", bridge);
