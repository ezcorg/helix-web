import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  // COOP/COEP headers required for SharedArrayBuffer (wasmer threads)
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    fs: {
      // Allow serving files from the wasmer-js build output
      allow: [".", "../wasmer-js/dist", "../wasmer-js/pkg"],
    },
  },
  resolve: {
    alias: {
      // Use our locally-built wasmer-js SDK instead of the npm package.
      // This ensures the wasm binary and JS glue are in sync.
      "@wasmer/sdk": path.resolve(__dirname, "../wasmer-js/dist/index.mjs"),
    },
  },
  // Ensure .wasm files are served correctly
  assetsInclude: ["**/*.wasm"],
  optimizeDeps: {
    exclude: ["@wasmer/sdk"],
  },
  build: {
    target: "esnext",
  },
});
