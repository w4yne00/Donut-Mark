import { describe, expect, it } from "vitest";
import { createDefaultAppRuntime, type NativeMarkdownOpenTarget } from "@markra/app/runtime";
import type { ElectronBridge } from "../electron/bridge";
import { createElectronRuntime } from "./runtime";

function createBridge() {
  const listeners = new Set<(name: string, payload: unknown) => unknown>();
  const stores = new Map<string, Map<string, unknown>>();
  const state = { open: true };
  const bridge: ElectronBridge = {
    files: createDefaultAppRuntime().files,
    settings: {
      async load(path, options) {
        if (!stores.has(path)) stores.set(path, new Map(Object.entries(options.defaults)));
      },
      async get(path, key) {
        return stores.get(path)?.get(key);
      },
      async set(path, key, value) {
        stores.get(path)!.set(key, value);
      },
      async delete(path, key) {
        stores.get(path)!.delete(key);
      },
      async save() {}
    },
    confirmDiscard: async () => false,
    takeOpenedPaths: async () => [],
    openEditor: async () => undefined,
    openSettings: async () => undefined,
    windowAction: async (action) => {
      if (action === "close" || action === "destroy") state.open = false;
    },
    windowLabel: async () => "main",
    setTitle: async () => undefined,
    setZoom: async () => undefined,
    listRestoreStates: async () => [],
    setRestoreState: async () => undefined,
    requestExit: async () => undefined,
    finishExit: async () => undefined,
    readClipboardText: async () => "",
    async emit(name, payload) {
      await Promise.all([...listeners].map((listener) => listener(name, payload)));
    },
    onEvent(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    }
  };
  return { bridge, state };
}

describe("Electron runtime", () => {
  it("delivers settings changes across windows until a listener is removed", async () => {
    const { bridge } = createBridge();
    const editor = createElectronRuntime(bridge);
    const settingsWindow = createElectronRuntime(bridge);
    const received: string[] = [];
    const cleanup = await editor.events.listen<{ language: string }>(
      "markra://language-changed",
      ({ payload }) => received.push(payload.language)
    );

    await settingsWindow.events.emit("markra://language-changed", { language: "zh-CN" });
    await settingsWindow.events.emit("markra://theme-changed", { theme: "dark" });
    expect(received).toEqual(["zh-CN"]);

    cleanup();
    await settingsWindow.events.emit("markra://language-changed", { language: "en" });
    expect(received).toEqual(["zh-CN"]);
  });

  it("shares setting values between renderer instances through the desktop store", async () => {
    const { bridge } = createBridge();
    const editor = createElectronRuntime(bridge);
    const settingsWindow = createElectronRuntime(bridge);
    const store = await editor.settings.loadStore("settings.json", {
      autoSave: false,
      defaults: { language: "en" }
    });
    await store.set("language", "zh-CN");
    await store.set("draft", "# 中文草稿");
    await store.save();

    const otherStore = await settingsWindow.settings.loadStore("settings.json", {
      autoSave: false,
      defaults: { language: "en" }
    });
    await expect(otherStore.get("language")).resolves.toBe("zh-CN");
    await expect(otherStore.get("draft")).resolves.toBe("# 中文草稿");
    await otherStore.delete("draft");
    await expect(store.get("draft")).resolves.toBeUndefined();
  });

  it("keeps unsaved content open until the shared close handler accepts closing", async () => {
    const { bridge, state } = createBridge();
    const runtime = createElectronRuntime(bridge);
    const draft = "# 尚未保存的中文正文";
    const reviewedDrafts: string[] = [];
    let accepted = false;
    const cleanup = await runtime.window.listenWindowCloseRequested(async (event) => {
      event.preventDefault();
      reviewedDrafts.push(draft);
      if (accepted) await runtime.window.destroyWindow();
    });

    await bridge.emit("markra:close-request", null);
    expect(reviewedDrafts).toEqual([draft]);
    expect(state.open).toBe(true);

    accepted = true;
    await bridge.emit("markra:close-request", null);
    expect(state.open).toBe(false);
    cleanup();
  });

  it("opens the chosen native document and preserves picker cancellation", async () => {
    const { bridge } = createBridge();
    let chosen: NativeMarkdownOpenTarget | null = {
      kind: "file",
      file: { path: "/home/cloud/文档.md", name: "文档.md", content: "# 麒麟中文文档" }
    };
    bridge.files.openMarkdownPath = async () => chosen;
    const runtime = createElectronRuntime(bridge);

    await expect(runtime.files.openMarkdownPath()).resolves.toEqual({
      kind: "file",
      file: { path: "/home/cloud/文档.md", name: "文档.md", content: "# 麒麟中文文档" }
    });

    chosen = null;
    await expect(runtime.files.openMarkdownPath()).resolves.toBeNull();
  });
});
