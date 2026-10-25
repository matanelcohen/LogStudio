import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  plugins: [react(), {
    name: "bundled-dependency-notices",
    generateBundle(_, bundle) {
      const packages = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const [id, module] of Object.entries(output.modules)) {
          if (!module.renderedLength) continue;
          const path = id.replaceAll("\\", "/").split("?")[0]!;
          const match = path.match(/\/(node_modules\/(?:.*\/node_modules\/)?(?:@[^/]+\/)?[^/]+)\//);
          if (match) packages.add(match[1]!);
        }
      }
      this.emitFile({ type: "asset", fileName: "bundled-dependencies.json", source: JSON.stringify([...packages].sort()) });
    }
  }],
  build: {
    target: "es2022",
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: "viewer.js",
        assetFileNames: "styles.[ext]",
        inlineDynamicImports: true
      }
    }
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    restoreMocks: true
  }
});
