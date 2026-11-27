import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createElectronSettings } from "./settings";

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "markra-settings-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Electron settings store", () => {
  it("persists Chinese drafts and merges concurrent saves without losing other keys", async () => {
    const directory = await temporaryDirectory();
    const settings = createElectronSettings(directory);
    await Promise.all([
      settings.load("settings.json", { defaults: { theme: "light" }, autoSave: false }),
      settings.load("settings.json", { defaults: { language: "en" }, autoSave: false })
    ]);
    await Promise.all([
      settings.set("settings.json", "theme", "dark").then(() => settings.save("settings.json")),
      settings.set("settings.json", "draft", "# 尚未保存的中文正文\n").then(() => settings.save("settings.json"))
    ]);

    const restarted = createElectronSettings(directory);
    await restarted.load("settings.json", { defaults: { theme: "light" }, autoSave: false });
    expect(await restarted.get("settings.json", "theme")).toBe("dark");
    expect(await restarted.get("settings.json", "language")).toBe("en");
    expect(await restarted.get("settings.json", "draft")).toBe("# 尚未保存的中文正文\n");
    await restarted.delete("settings.json", "draft");
    await restarted.save("settings.json");
    const reopened = createElectronSettings(directory);
    await reopened.load("settings.json", { defaults: {}, autoSave: false });
    expect(await reopened.get("settings.json", "draft")).toBeUndefined();
  });

  it("limits storage to named app settings and rejects symlinks and path traversal", async () => {
    const directory = await temporaryDirectory();
    const settings = createElectronSettings(directory);
    const options = { defaults: {}, autoSave: false };
    await expect(settings.load("../private.json", options)).rejects.toThrow();
    await expect(settings.load("/etc/passwd", options)).rejects.toThrow();
    await expect(settings.load("file-access.json", options)).rejects.toThrow();
    await expect(settings.set("ai-agent-sessions/../../private.json", "key", "value")).rejects.toThrow();
    const outside = join(directory, "private.json");
    await writeFile(outside, '{"private":true}');
    await symlink(outside, join(directory, "settings.json"));
    await expect(settings.load("settings.json", options)).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe('{"private":true}');
  });

  it("reports corrupt settings and failed writes instead of discarding previous values", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "settings.json");
    await writeFile(path, "{invalid");
    await expect(createElectronSettings(directory).load("settings.json", { defaults: {}, autoSave: false })).rejects.toThrow();
    await writeFile(path, '{"theme":"light"}');
    const settings = createElectronSettings(directory);
    await settings.load("settings.json", { defaults: {}, autoSave: false });
    await settings.set("settings.json", "theme", "dark");
    await chmod(path, 0o400);
    try {
      await expect(settings.save("settings.json")).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe('{"theme":"light"}');
    } finally {
      await chmod(path, 0o600);
    }
    await settings.save("settings.json");
    const restarted = createElectronSettings(directory);
    await restarted.load("settings.json", { defaults: {}, autoSave: false });
    expect(await restarted.get("settings.json", "theme")).toBe("dark");
  });

  it("automatically saves session changes and isolates stored values from caller mutation", async () => {
    const directory = await temporaryDirectory();
    const settings = createElectronSettings(directory);
    const path = "ai-agent-sessions/default.json";
    await settings.load(path, { defaults: {}, autoSave: true });
    const draft = { content: "中文草稿" };
    await settings.set(path, "draft", draft);
    draft.content = "caller mutation";
    const restarted = createElectronSettings(directory);
    await restarted.load(path, { defaults: {}, autoSave: true });
    expect(await restarted.get(path, "draft")).toEqual({ content: "中文草稿" });
    await restarted.delete(path, "draft");
    const reopened = createElectronSettings(directory);
    await reopened.load(path, { defaults: {}, autoSave: false });
    expect(await reopened.get(path, "draft")).toBeUndefined();
  });
});
