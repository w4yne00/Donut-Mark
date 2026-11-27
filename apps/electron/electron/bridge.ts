import type {
  AppFileRuntime,
  AppThemesRuntime,
  NativeEditorWindowRestoreState,
  NativeSettingsWindowTarget,
  RuntimeStoreLoadOptions,
  SetNativeEditorWindowRestoreStateInput
} from "@markra/app/runtime";

export type ElectronFiles = Pick<AppFileRuntime,
  | "openMarkdownFile"
  | "openMarkdownPath"
  | "openMarkdownFolder"
  | "readMarkdownFile"
  | "saveMarkdownFile"
  | "resolveMarkdownPath"
  | "listMarkdownFilesForPath"
  | "readMarkdownImageFile"
  | "watchMarkdownFile"
  | "watchMarkdownTree"
>;

export type ElectronFileWatchEvent = { kind: "file" | "tree"; path: string };

export type ElectronSettings = {
  load: (path: string, options: RuntimeStoreLoadOptions) => Promise<unknown>;
  get: (path: string, key: string) => Promise<unknown>;
  set: (path: string, key: string, value: unknown) => Promise<unknown>;
  delete: (path: string, key: string) => Promise<unknown>;
  save: (path: string) => Promise<unknown>;
};

export type WindowAction = "close" | "destroy" | "minimize" | "maximize" | "fullscreen" | "show";

export type ElectronBridge = {
  files: ElectronFiles;
  themes: AppThemesRuntime;
  settings: ElectronSettings;
  confirmDiscard: AppFileRuntime["confirmUnsavedMarkdownDocumentDiscard"];
  takeOpenedPaths: () => Promise<string[]>;
  openEditor: (path?: string) => Promise<unknown>;
  openSettings: (target?: NativeSettingsWindowTarget) => Promise<unknown>;
  windowAction: (action: WindowAction) => Promise<unknown>;
  windowLabel: () => Promise<string>;
  setTitle: (title: string) => Promise<unknown>;
  setZoom: (factor: number) => Promise<unknown>;
  listRestoreStates: () => Promise<NativeEditorWindowRestoreState[]>;
  setRestoreState: (state: SetNativeEditorWindowRestoreStateInput) => Promise<unknown>;
  requestExit: () => Promise<unknown>;
  finishExit: () => Promise<unknown>;
  readClipboardText: () => Promise<string>;
  emit: (name: string, payload: unknown) => Promise<unknown>;
  onEvent: (handler: (name: string, payload: unknown) => unknown) => () => unknown;
};

export const settingsEvents = new Set([
  "markra://theme-changed",
  "markra://custom-theme-css-changed",
  "markra://language-changed",
  "markra://log-level-changed",
  "markra://editor-preferences-changed",
  "markra://export-settings-changed",
  "markra://file-ignore-settings-changed",
  "markra://web-search-settings-changed",
  "markra://backup-settings-changed",
  "markra://sync-settings-changed",
  "markra://ai-settings-changed",
  "markra://acp-agent-settings-changed",
  "markra://theme-files-changed"
]);
