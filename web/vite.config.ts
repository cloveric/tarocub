import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Emits ONE self-contained web/dist/index.html (all JS + CSS inlined) so the
// bridge can serve it as a string constant with no runtime file dependency.
// The main tsc build never touches this file; scripts/inline-web.mjs turns the
// built HTML into src/ui/console-html.ts.
export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 100_000,
  },
});
