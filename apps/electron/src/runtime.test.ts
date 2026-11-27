import { describe, expect, it, vi } from "vitest";
import { createDefaultAppRuntime, type NativeMarkdownOpenTarget } from "@markra/app/runtime";
import type { ElectronBridge } from "../electron/bridge";
import { createElectronRuntime } from "./runtime";

function createBridge() {
  const listeners = new Set<(name: string, payload: unknown) => unknown>();
  const stores = new Map<string, Map<string, unknown>>();
  const state = { open: true };
  const bridge: ElectronBridge = {
    ai: {
      getConfig: async () => ({ baseUrl: "", model: "", apiKey: "" }),
      saveConfig: async (config) => config,
      chat: async () => ({ status: 200 }),
      stop: async () => undefined
    },
    files: createDefaultAppRuntime().files,
    themes: {
      list: async (directory) => ({ directory: directory ?? "/themes", files: ["light.css"] }),
      read: async () => ":root { color: black; }",
      openFolder: async () => undefined,
      chooseFolder: async () => "/themes"
    },
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
  it("shows chunks before the request completes and discards queued chunks after stop", async () => {
    const { bridge } = createBridge();
    const pending = Promise.withResolvers<{ status: number }>();
    let sendChunk: ((chunk: string) => unknown) | undefined;
    bridge.ai.chat = vi.fn((_id, _request, onChunk) => {
      sendChunk = onChunk;
      onChunk?.("第一段");
      return pending.promise;
    });
    bridge.ai.stop = vi.fn(async () => undefined);
    const runtime = createElectronRuntime(bridge);
    const controller = new AbortController();
    const onChunk = vi.fn();
    const request = { body: "{}", headers: { authorization: "ignored" }, url: "http://localhost/v1/chat/completions" };
    const result = runtime.ai.requestChatStream(request, onChunk, controller.signal);
    expect(onChunk.mock.calls).toEqual([["第一段"]]);
    controller.abort();
    sendChunk?.("停止后排队的内容");
    pending.resolve({ status: 200 });
    await result;
    expect(bridge.ai.stop).toHaveBeenCalledExactlyOnceWith(1);
    expect(onChunk.mock.calls).toEqual([["第一段"]]);
    await expect(runtime.ai.requestChatStream(request, onChunk, controller.signal)).rejects.toThrow();
    expect(bridge.ai.chat).toHaveBeenCalledExactlyOnceWith(1, { body: request.body, url: request.url }, expect.any(Function));
  });

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
