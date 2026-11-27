import { contextBridge, ipcRenderer } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

async function bridge() {
  await import("./preload");
  return vi.mocked(contextBridge.exposeInMainWorld).mock.calls[0][1] as ElectronBridge;
}

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
    const { files } = await bridge();
    vi.mocked(ipcRenderer.invoke).mockRejectedValueOnce(new Error("not authorized"));
    await expect(files.watchMarkdownTree("/private", vi.fn())).rejects.toThrow("not authorized");
    expect(ipcRenderer.listenerCount("markra:event")).toBe(0);
  });
});
