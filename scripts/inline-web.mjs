// Turns the Vite single-file build (web/dist/index.html) into a TypeScript
// string constant at src/ui/console-html.ts, so the main `tsc` build has no
// runtime dependency on Vite or on the built HTML file existing on disk.
//
// Run via `npm run build:web` (which first runs `vite build web`).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const htmlPath = path.join(repoRoot, "web", "dist", "index.html");
const outPath = path.join(repoRoot, "src", "ui", "console-html.ts");

let html;
try {
  html = await readFile(htmlPath, "utf8");
} catch (err) {
  console.error(`inline-web: could not read ${htmlPath}. Run \`vite build web\` first.`);
  throw err;
}

// Escape for a JS template literal: backslash first, then backtick, then ${.
const escaped = html
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

const banner = [
  "// AUTO-GENERATED — do not edit by hand.",
  "// Source: web/ (Vite + React single-file build). Regenerate with `npm run build:web`.",
  "// This inlines the entire self-contained console HTML so ui-server.ts can serve it",
  "// with no runtime dependency on Vite or on web/dist/index.html.",
  "/* eslint-disable */",
  "",
].join("\n");

const ts = `${banner}export const CONSOLE_HTML = \`${escaped}\`;\n`;
await writeFile(outPath, ts, "utf8");

console.log(
  `inline-web: wrote ${path.relative(repoRoot, outPath)} (${ts.length} bytes) ` +
    `from ${path.relative(repoRoot, htmlPath)} (${html.length} bytes).`,
);
