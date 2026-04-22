import { defineConfig } from "vite";

export default defineConfig({
  // Set by the GitHub Pages workflow to the repo subpath (e.g. "/helix-web/").
  // Defaults to "/" for local dev.
  base: process.env.VITE_BASE || "/",
  // COOP/COEP headers required for SharedArrayBuffer (wasmer threads)
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    fs: {
      // Allow serving files from one level up to the project root
      allow: ['..'],
    },
  },
  // Ensure .wasm files are served correctly
  assetsInclude: ["**/*.wasm"],
  optimizeDeps: {
    exclude: ["@joinezco/wasmersdk"],
  },
  build: {
    target: "esnext",
  },
});
