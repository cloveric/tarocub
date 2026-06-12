import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ClaudeInstructionsFile = {
  path: string;
  cleanup: () => Promise<void>;
};

export async function createClaudeInstructionsFile(instructions: string | null): Promise<ClaudeInstructionsFile | null> {
  const trimmed = instructions?.trim();
  if (!trimmed) {
    return null;
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), "cctb-claude-instructions-"));
  const filePath = path.join(dir, "instructions.md");
  await writeFile(filePath, trimmed, { encoding: "utf8", mode: 0o600 });
  return {
    path: filePath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
