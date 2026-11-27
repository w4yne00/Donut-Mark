import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App, { AppErrorBoundary, configureAppRuntime } from "@markra/app";
import "@markra/app/styles.css";
import type { ElectronBridge } from "../electron/bridge";
import { createElectronRuntime } from "./runtime";

declare global {
  const __MARKRA_APP_VERSION__: string;
  const __MARKRA_DEBUG__: boolean;

  interface Window {
    markra: ElectronBridge;
  }
}

if (!window.markra) throw new Error("Electron 桌面接口未加载，无法安全打开文档。");
configureAppRuntime(createElectronRuntime(window.markra));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>
);
