import { contextBridge, ipcRenderer } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronBridge } from "./bridge";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    contextBridge: { exposeInMainWorld: vi.fn() },
    ipcRenderer: Object.assign(new EventEmitter(), { invoke: vi.fn(async () => undefined) })
  };
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  ipcRenderer.removeAllListeners();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function bridge() {
  await import("./preload");
  return vi.mocked(contextBridge.exposeInMainWorld).mock.calls[0][1] as ElectronBridge;
}

describe("Electron preload events", () => {
  it("supports concurrent app subscriptions without a listener warning and releases them on cleanup", async () => {
    const api = await bridge();
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const handlers = Array.from({ length: 11 }, () => vi.fn());
    const stops = handlers.map((handler) => api.onEvent(handler));
    try {
      for (let index = 0; index < 11; index++) {
        stops.push(await api.files.watchMarkdownFile(`/notes/${index}.md`, vi.fn()));
      }
      stops.push(await api.files.watchMarkdownTree("/notes", vi.fn()));
      ipcRenderer.emit("markra:event", { sender: "privileged" }, "markra://theme-changed", "dark");
      for (const handler of handlers) {
        expect(handler.mock.calls).toEqual([["markra://theme-changed", "dark"]]);
      }
      expect(warning).not.toHaveBeenCalled();
    } finally {
      await Promise.all(stops.map((stop) => stop()));
    }
    expect(ipcRenderer.listenerCount("markra:event")).toBe(0);
  });

  it("releases mixed app, file, tree and AI subscriptions across repeated lifecycles", async () => {
    const api = await bridge();
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const defaultLimit = ipcRenderer.getMaxListeners();
    for (let cycle = 0; cycle < 1000; cycle++) {
      const handlers = Array.from({ length: 11 }, () => vi.fn());
      const stops = handlers.map((handler) => api.onEvent(handler));
      stops.push(await api.files.watchMarkdownFile("/notes/a.md", vi.fn()));
      stops.push(await api.files.watchMarkdownTree("/notes", vi.fn()));
      await api.ai.chat(cycle + 1, { body: "{}", url: "http://localhost/v1/chat/completions" }, vi.fn());
      await Promise.all(stops.map((stop) => stop()));
      expect(ipcRenderer.listenerCount("markra:event")).toBe(0);
      ipcRenderer.emit("markra:event", {}, "markra://theme-changed", "dark");
      expect(handlers.every((handler) => handler.mock.calls.length === 0)).toBe(true);
    }
    expect(ipcRenderer.getMaxListeners()).toBe(defaultLimit);
  });

  it("cleans up repeated subscriptions to the same callback independently", async () => {
    const api = await bridge();
    const handler = vi.fn();
    const first = api.onEvent(handler);
    const second = api.onEvent(handler);
    first();
    first();
    ipcRenderer.emit("markra:event", {}, "theme", "dark");
    expect(handler.mock.calls).toEqual([["theme", "dark"]]);
    second();
    expect(ipcRenderer.listenerCount("markra:event")).toBe(0);
  });

  it("preserves the current delivery when a callback changes subscriptions", async () => {
    const api = await bridge();
    const late = vi.fn();
    const next = vi.fn();
    let stopLate = () => {};
    const stopFirst = api.onEvent(() => {
      stopSecond();
      stopLate = api.onEvent(late);
    });
    const stopSecond = api.onEvent(next);
    ipcRenderer.emit("markra:event", {}, "theme", "dark");
    expect(next).toHaveBeenCalledExactlyOnceWith("theme", "dark");
    expect(late).not.toHaveBeenCalled();
    stopFirst();
    stopSecond();
    stopLate();
    expect(ipcRenderer.listenerCount("markra:event")).toBe(0);
  });
});

describe("Electron preload AI streams", () => {
  it.each(["success", "failure", "cancelled"])("releases a %s stream without stopping other subscribers", async (outcome) => {
    const api = await bridge();
    const event = vi.fn();
    const stopEvent = api.onEvent(event);
    const onChunk = vi.fn();
    const pending = Promise.withResolvers<{ status: number }>();
    vi.mocked(ipcRenderer.invoke).mockImplementationOnce(() => pending.promise);
    const request = api.ai.chat(7, { body: "{}", url: "http://localhost/v1/chat/completions" }, onChunk);
    ipcRenderer.emit("markra:event", { sender: "privileged" }, "markra:ai-chunk-8", "other request");
    ipcRenderer.emit("markra:event", {}, "markra:ai-chunk-7", 123);
    ipcRenderer.emit("markra:event", {}, "markra:ai-chunk-7", "first chunk");
    expect(onChunk.mock.calls).toEqual([["first chunk"]]);
    if (outcome === "failure") {
      pending.reject(new Error("connection closed"));
      await expect(request).rejects.toThrow("connection closed");
    } else {
      if (outcome === "cancelled") await api.ai.stop(7);
      pending.resolve({ status: outcome === "cancelled" ? 499 : 200 });
      await request;
    }
    ipcRenderer.emit("markra:event", {}, "markra:ai-chunk-7", "late chunk");
    expect(onChunk.mock.calls).toEqual([["first chunk"]]);
    expect(event).toHaveBeenLastCalledWith("markra:ai-chunk-7", "late chunk");
    stopEvent();
    expect(ipcRenderer.listenerCount("markra:event")).toBe(0);
  });
});

describe("Electron preload watches", () => {
  it("subscribes before starting the watch and routes file and tree events without exposing native events", async () => {
    const { files } = await bridge();
    const file = vi.fn();
    const tree = vi.fn();
    vi.mocked(ipcRenderer.invoke).mockImplementationOnce(async () => {
      ipcRenderer.emit("markra:event", { sender: "privileged" }, "markra:watch-1", { kind: "file", path: "/notes/a.md" });
    });
    const stop = await files.watchMarkdownFile("/notes/a.md", file, tree);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("markra:watch-start", 1, "file", "/notes/a.md");
    expect(file.mock.calls).toEqual([["/notes/a.md"]]);
    ipcRenderer.emit("markra:event", {}, "markra:watch-2", { kind: "file", path: "/other.md" });
    ipcRenderer.emit("markra:event", {}, "markra:watch-1", { kind: "tree", path: "/notes" });
    expect(file).toHaveBeenCalledTimes(1);
    expect(tree.mock.calls).toEqual([["/notes"]]);
    await stop();
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith("markra:watch-stop", 1);
    expect(ipcRenderer.listenerCount("markra:event")).toBe(0);
  });

  it("removes the event listener when watch setup is rejected", async () => {
    const { files, onEvent } = await bridge();
    const event = vi.fn();
    const stopEvent = onEvent(event);
    vi.mocked(ipcRenderer.invoke).mockRejectedValueOnce(new Error("not authorized"));
    await expect(files.watchMarkdownTree("/private", vi.fn())).rejects.toThrow("not authorized");
    ipcRenderer.emit("markra:event", {}, "theme", "dark");
    expect(event).toHaveBeenCalledExactlyOnceWith("theme", "dark");
    stopEvent();
    expect(ipcRenderer.listenerCount("markra:event")).toBe(0);
  });
});
