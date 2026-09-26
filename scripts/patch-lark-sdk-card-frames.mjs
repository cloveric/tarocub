import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkRoot = path.join(repositoryRoot, "node_modules", "@larksuiteoapi", "node-sdk");
const manifest = JSON.parse(await readFile(path.join(sdkRoot, "package.json"), "utf8"));

if (manifest.version !== "1.73.3") {
  throw new Error(`Unsupported @larksuiteoapi/node-sdk version ${manifest.version}; review the card-frame patch`);
}

const oldCondition = "if (type !== MessageType.event) {";
const newCondition = "if (type !== MessageType.event && type !== MessageType.card) {";
const oldOptionField = "            option: (_m = event.action) === null || _m === void 0 ? void 0 : _m.option,\n";
const newOptionFields = `${oldOptionField}            options: event.action == null ? undefined : event.action.options,\n            input_value: event.action == null ? undefined : event.action.input_value,\n            form_value: event.action == null ? undefined : event.action.form_value,\n            checked: event.action == null ? undefined : event.action.checked,\n            timezone: event.action == null ? undefined : event.action.timezone,\n`;
let patched = 0;

// Feishu now sends interactive-card callbacks as CARD frames, but SDK 1.73.3
// enumerates that frame type and then silently discards it before dispatch.
for (const relativePath of ["lib/index.js", "es/index.js"]) {
  const filePath = path.join(sdkRoot, relativePath);
  let source = await readFile(filePath, "utf8");
  let changed = false;

  if (!source.includes(newCondition)) {
    const occurrences = source.split(oldCondition).length - 1;
    if (occurrences !== 1) {
      throw new Error(`Expected one card-frame guard in ${relativePath}, found ${occurrences}`);
    }
    source = source.replace(oldCondition, newCondition);
    changed = true;
  }

  // normalizeCardAction currently keeps only value/tag/name/option. Preserve
  // the remaining Feishu interaction fields too, especially form_value: form
  // submissions otherwise arrive as empty even though the raw callback has all
  // answers. Keep the raw-event fallback in TaroCub for older installs.
  if (!source.includes("form_value: event.action == null ? undefined : event.action.form_value,")) {
    const occurrences = source.split(oldOptionField).length - 1;
    if (occurrences !== 1) {
      throw new Error(`Expected one card-action option field in ${relativePath}, found ${occurrences}`);
    }
    source = source.replace(oldOptionField, newOptionFields);
    changed = true;
  }

  if (changed) {
    await writeFile(filePath, source, "utf8");
    patched += 1;
  }
}

console.log(patched > 0
  ? "Patched Lark SDK WebSocket card callbacks."
  : "Lark SDK WebSocket card callbacks are already patched.");
