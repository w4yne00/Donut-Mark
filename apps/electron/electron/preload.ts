import { contextBridge, ipcRenderer } from "electron";
import type { ElectronBridge, ElectronFileWatchEvent } from "./bridge";

let nextWatchId = 0;

async function watchPath(kind: "file" | "tree", path: string, onChange: (event: ElectronFileWatchEvent) => unknown) {
  const id = ++nextWatchId;
  const eventName = `markra:watch-${id}`;
  const listener = (_event: Electron.IpcRendererEvent, name: string, payload: ElectronFileWatchEvent) => {
    if (name === eventName) onChange(payload);
  };
  ipcRenderer.on("markra:event", listener);
  try {
    await ipcRenderer.invoke("markra:watch-start", id, kind, path);
  } catch (error) {
    ipcRenderer.removeListener("markra:event", listener);
    throw error;
  }
  return () => {
    ipcRenderer.removeListener("markra:event", listener);
    return ipcRenderer.invoke("markra:watch-stop", id).catch(console.error);
  };
}

const bridge: ElectronBridge = {
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
  onEvent: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, name: string, payload: unknown) => handler(name, payload);
    ipcRenderer.on("markra:event", listener);
    return () => ipcRenderer.removeListener("markra:event", listener);
  }
};

contextBridge.exposeInMainWorld("markra", bridge);
