import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const committedOutput = path.join(root, "dist", "search-mcp.js");
const check = process.argv.includes("--check");
const output = check
  ? path.join(root, ".dist-check", `${process.pid}-${randomUUID()}.js`)
  : committedOutput;

await mkdir(path.dirname(output), { recursive: true });

try {
  await build({
    entryPoints: [path.join(root, "src", "search-mcp-server.ts")],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    legalComments: "none",
    sourcemap: false,
    charset: "utf8",
    logLevel: "info",
  });

  const bundled = await readFile(output, "utf8");
  const normalized = bundled.replace(/[ \t]+$/gm, "");
  if (normalized !== bundled) {
    await writeFile(output, normalized, "utf8");
  }

  if (check) {
    const [expected, actual] = await Promise.all([
      readFile(committedOutput),
      readFile(output),
    ]);
    if (!expected.equals(actual)) {
      throw new Error("dist/search-mcp.js is stale; run npm run build and commit the result");
    }
  }
} finally {
  if (check) {
    await rm(path.dirname(output), { recursive: true, force: true });
  }
}
