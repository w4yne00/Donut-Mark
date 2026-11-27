import { createElement } from "react";
import {
  contextMenuPositionFromEvent,
  createDefaultAppRuntime,
  createEditorContextMenuEntries,
  createEditorContextMenuEntriesFromOptions,
  createMarkdownFileTreeContextMenuEntries,
  currentContextMenuPosition,
  showContextMenu,
  type AppRuntime,
  type RuntimeCleanup
} from "@markra/app/runtime";
import type { ElectronBridge } from "../electron/bridge";

const menuPrefixes = { editor: "markra:electron-editor", fileTree: "markra:electron-file-tree" };

const createFileTreeMenu: AppRuntime["menu"]["createMarkdownFileTreeContextMenuItems"] = (handlers, language, file) =>
  createMarkdownFileTreeContextMenuEntries(handlers, language, file, menuPrefixes).map((entry) =>
    entry.kind === "item" && entry.id === `${menuPrefixes.fileTree}:new`
      ? {
        ...entry,
        icon: createElement("span", {
          "aria-hidden": true,
          style: {
            display: "block",
            width: 16,
            height: 16,
            backgroundColor: "currentColor",
            maskImage: 'url("/icons/donut-mark-symbolic.svg")',
            maskSize: "contain",
            maskRepeat: "no-repeat"
          }
        })
      }
      : entry
  );

function unavailable(feature: string): Promise<never> {
  return Promise.reject(new Error(`麒麟基础包暂不支持${feature}。`));
}

export function createElectronRuntime(bridge: ElectronBridge): AppRuntime {
  const defaults = createDefaultAppRuntime();
  const listen = (name: string, handler: (payload: unknown) => unknown) =>
    bridge.onEvent((eventName, payload) => {
      if (eventName === name) return handler(payload);
    });

  return {
    ...defaults,
    features: {
      ai: false,
      export: false,
      nativeWindowChrome: false,
      networkProxy: false,
      pandoc: false,
      s3ImageUpload: false,
      spellcheck: false,
      updater: false
    },
    files: {
      ...defaults.files,
      ...bridge.files,
      confirmUnsavedMarkdownDocumentDiscard: bridge.confirmDiscard,
      openMarkdownFileInNewWindow: bridge.openEditor,
      openMarkdownFolderInNewWindow: () => unavailable("在新窗口打开文件夹"),
      openLocalFiles: () => unavailable("导入附件或主题"),
      openLocalImages: () => unavailable("导入图片"),
      openSettingsFile: () => unavailable("导入设置"),
      saveSettingsFile: () => unavailable("导出设置"),
      saveHtmlFile: () => unavailable("导出 HTML"),
      savePandocFile: () => unavailable("Pandoc 导出"),
      savePdfFile: () => unavailable("导出 PDF"),
      takeOpenedMarkdownPaths: bridge.takeOpenedPaths,
      listenOpenedMarkdownPaths: async (handler) => listen("markra:opened-paths", (payload) => {
        if (Array.isArray(payload) && payload.every((path) => typeof path === "string")) {
          return handler(payload);
        }
      })
    },
    events: {
      emit: bridge.emit,
      isAvailable: () => true,
      listen: async <TPayload>(name: string, handler: (event: { payload: TPayload }) => unknown) =>
        listen(name, (payload) => handler({ payload: payload as TPayload }))
    },
    settings: {
      async loadStore(path, options) {
        await bridge.settings.load(path, options);
        return {
          delete: (key) => bridge.settings.delete(path, key),
          get: async <T>(key: string) => await bridge.settings.get(path, key) as T | undefined,
          save: () => bridge.settings.save(path),
          set: (key, value) => bridge.settings.set(path, key, value)
        };
      }
    },
    platform: {
      resolveDesktopOsVersion: () => null,
      resolveDesktopPlatform: () => "linux"
    },
    menu: {
      ...defaults.menu,
      readClipboardText: bridge.readClipboardText,
      readClipboardContent: async () => {
        const text = await bridge.readClipboardText();
        return text ? { text } : null;
      },
      createEditorContextMenuItems: (handlers, language, options) =>
        createEditorContextMenuEntries(handlers, language, options, menuPrefixes),
      createMarkdownFileTreeContextMenuItems: createFileTreeMenu,
      installEditorContextMenu: async (target, handlers, language = "en", options = {}) => {
        let closeMenu: RuntimeCleanup | null = null;
        const onContextMenu = (event: Event) => {
          if (!(event instanceof MouseEvent) || !(event.target instanceof Element)) return;
          if (!event.target.closest(".markdown-paper")) return;
          event.preventDefault();
          event.stopPropagation();
          closeMenu?.();
          closeMenu = showContextMenu(document, {
            entries: createEditorContextMenuEntriesFromOptions(
              handlers, language, options, menuPrefixes, event.target
            ),
            position: contextMenuPositionFromEvent(event)
          });
        };
        target.addEventListener("contextmenu", onContextMenu);
        return () => {
          target.removeEventListener("contextmenu", onContextMenu);
          closeMenu?.();
        };
      },
      showMarkdownFileTreeContextMenu: async (handlers, language, file) => {
        showContextMenu(document, {
          entries: createFileTreeMenu(handlers, language, file),
          position: currentContextMenuPosition(document)
        });
      }
    },
    window: {
      ...defaults.window,
      closeWindow: () => bridge.windowAction("close"),
      destroyWindow: () => bridge.windowAction("destroy"),
      exitApp: bridge.finishExit,
      getCurrentWindowLabel: bridge.windowLabel,
      hideSettingsWindow: () => bridge.windowAction("close"),
      listEditorWindowRestoreStates: bridge.listRestoreStates,
      listenAppExitRequested: async (handler) => listen("markra:app-exit-request", handler),
      listenSettingsWindowTarget: async (handler) => listen("markra:settings-target", (payload) => {
        if (payload === "exportPandocPath") return handler(payload);
      }),
      listenWindowCloseRequested: async (handler) => listen("markra:close-request", () =>
        // The main process already prevented the native close event.
        handler({ preventDefault: () => undefined })),
      minimizeWindow: () => bridge.windowAction("minimize"),
      openBlankEditorWindow: () => bridge.openEditor(),
      openExternalUrl: () => unavailable("打开外部链接"),
      openSettingsWindow: bridge.openSettings,
      requestAppExit: bridge.requestExit,
      setEditorWindowRestoreState: bridge.setRestoreState,
      setUiZoom: bridge.setZoom,
      setWindowTitle: bridge.setTitle,
      showWindow: () => bridge.windowAction("show"),
      toggleWindowFullscreen: () => bridge.windowAction("fullscreen"),
      toggleWindowMaximized: () => bridge.windowAction("maximize")
    }
  };
}
