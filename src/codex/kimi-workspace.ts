import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const LEGACY_MANAGED_START = "<!-- TaroCub Kimi instructions: start -->";
const LEGACY_MANAGED_END = "<!-- TaroCub Kimi instructions: end -->";
const SYSTEM_MANAGED_START = "<!-- TaroCub Kimi system instructions: start -->";
const SYSTEM_MANAGED_END = "<!-- TaroCub Kimi system instructions: end -->";
const GENERATED_AGENT_BASE = [
  "---",
  "name: agent",
  "description: TaroCub bridge main-agent wrapper",
  "override: true",
  "---",
  "",
  "${base_prompt}",
  "",
  "${plugin_sections}",
].join("\n");

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function withoutManagedBlocks(
  content: string,
  startMarker: string,
  endMarker: string,
): { content: string; found: boolean } {
  let next = content;
  let found = false;
  while (true) {
    const start = next.indexOf(startMarker);
    if (start < 0) {
      return { content: next.trimEnd(), found };
    }
    const end = next.indexOf(endMarker, start + startMarker.length);
    if (end < 0) {
      throw new Error(`Kimi workspace file contains an incomplete TaroCub managed block: ${startMarker}`);
    }
    next = `${next.slice(0, start)}${next.slice(end + endMarker.length)}`;
    found = true;
  }
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim().replace(/\s+#.*$/, "").trim();
  if (trimmed.length >= 2 && (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function validateProjectMainAgent(content: string): void {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter) {
    throw new Error(
      "Existing .kimi-code/agents/agent.md has no valid frontmatter; TaroCub cannot guarantee its system instructions are active",
    );
  }
  const name = frontmatter.match(/^name\s*:\s*(.+)$/mi)?.[1];
  if (!name || unquoteYamlScalar(name).toLowerCase() !== "agent") {
    throw new Error(
      "Existing .kimi-code/agents/agent.md does not define the default 'agent' profile; TaroCub cannot safely install system instructions",
    );
  }
  if (!/^override\s*:\s*true(?:\s+#.*)?$/mi.test(frontmatter)) {
    throw new Error(
      "Existing .kimi-code/agents/agent.md must set override: true before TaroCub can safely install system instructions",
    );
  }
  if (!content.includes("${base_prompt}")) {
    throw new Error(
      "Existing .kimi-code/agents/agent.md must include ${base_prompt} so Kimi's built-in runtime and Skill instructions remain active",
    );
  }
  if (!content.includes("${plugin_sections}")) {
    throw new Error(
      "Existing .kimi-code/agents/agent.md must include ${plugin_sections} so Kimi plugin instructions remain active",
    );
  }
}

async function replaceFileAtomically(filePath: string, content: string | null): Promise<void> {
  if (content === null) {
    await unlink(filePath).catch((error: unknown) => {
      const code = typeof error === "object" && error !== null && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      if (code !== "ENOENT") {
        throw error;
      }
    });
    return;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Install per-instance/channel guidance through Kimi's project main-agent
 * override. `${base_prompt}` retains Kimi's built-in runtime, workspace, and
 * Skill context, while `${plugin_sections}` retains enabled plugin guidance.
 */
export async function syncKimiWorkspaceInstructions(
  workspacePath: string,
  instructions: string | null,
): Promise<string> {
  const configDir = path.join(workspacePath, ".kimi-code");
  const agentsPath = path.join(configDir, "AGENTS.md");
  const mainAgentPath = path.join(configDir, "agents", "agent.md");

  // Migrate the earlier reference-data implementation without touching any
  // project-owned AGENTS content around its managed block.
  const existingAgents = await readOptionalFile(agentsPath);
  const cleanedAgents = withoutManagedBlocks(existingAgents, LEGACY_MANAGED_START, LEGACY_MANAGED_END);
  const normalizedAgents = cleanedAgents.content ? `${cleanedAgents.content}\n` : "";
  if (cleanedAgents.found && normalizedAgents !== existingAgents) {
    await replaceFileAtomically(agentsPath, normalizedAgents || null);
  }

  const existingMainAgent = await readOptionalFile(mainAgentPath);
  const cleanedMainAgent = withoutManagedBlocks(existingMainAgent, SYSTEM_MANAGED_START, SYSTEM_MANAGED_END);
  let base = cleanedMainAgent.content;
  const trimmedInstructions = instructions?.trim() ?? "";
  if (
    trimmedInstructions.includes(SYSTEM_MANAGED_START)
    || trimmedInstructions.includes(SYSTEM_MANAGED_END)
  ) {
    throw new Error("Kimi instructions contain a reserved TaroCub managed-block marker");
  }
  let normalizedMainAgent: string | null;

  if (trimmedInstructions) {
    if (!base) {
      base = GENERATED_AGENT_BASE;
    } else {
      validateProjectMainAgent(base);
    }
    normalizedMainAgent = [
      base,
      "",
      SYSTEM_MANAGED_START,
      trimmedInstructions,
      SYSTEM_MANAGED_END,
      "",
    ].join("\n");
  } else if (base === GENERATED_AGENT_BASE) {
    normalizedMainAgent = null;
  } else {
    normalizedMainAgent = base ? `${base}\n` : null;
  }

  const expectedMainAgent = normalizedMainAgent ?? "";
  if (expectedMainAgent !== existingMainAgent) {
    await replaceFileAtomically(mainAgentPath, normalizedMainAgent);
  }

  // Both files contribute to Kimi's startup context. Returning both makes the
  // adapter restart a resident worker when either project-owned surface changes.
  return [
    "[.kimi-code/agents/agent.md]",
    expectedMainAgent,
    "[.kimi-code/AGENTS.md]",
    normalizedAgents || existingAgents,
  ].join("\n");
}
