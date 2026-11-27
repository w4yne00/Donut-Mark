import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
  const preload = mode === "preload";
  return {
    build: {
      target: "node22",
      outDir: "dist-electron",
      emptyOutDir: !preload,
      lib: {
        entry: preload ? "electron/preload.ts" : "electron/main.ts",
        formats: [preload ? "cjs" : "es"],
        fileName: () => preload ? "preload.cjs" : "main.js"
      },
      rolldownOptions: {
        external: ["electron", /^node:/]
      }
    }
  };
});
