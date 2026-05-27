import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildLarkCliChannelEnv } from "./cli-env.js";

const execFile = promisify(execFileCallback);

export interface LarkDocumentCreateInput {
  title?: string;
  content: string;
  docFormat?: "xml" | "markdown";
  as?: "user" | "bot";
  parentToken?: string;
  parentPosition?: string;
}

export interface LarkDocumentCreateResult {
  title?: string;
  url?: string;
  documentId?: string;
  warning?: string;
}

export async function createLarkDocumentWithCli(input: LarkDocumentCreateInput): Promise<LarkDocumentCreateResult> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-doc-"));
  const contentFileName = "content.md";
  const contentPath = path.join(tempDir, contentFileName);
  const docFormat = input.docFormat ?? inferDocFormat(input.content);
  if (docFormat !== "markdown") {
    throw new Error("lark.doc.create currently requires markdown content with the installed lark-cli");
  }
  await writeFile(contentPath, input.content);
  const args = [
    "docs",
    "--api-version",
    "v2",
    "+create",
    "--as",
    input.as ?? resolveDefaultLarkDocumentActor(),
  ];
  if (input.title?.trim()) {
    args.push("--title", input.title.trim());
  }
  args.push(
    "--content",
    `@${contentFileName}`,
    "--doc-format",
    "markdown",
  );
  if (input.parentToken) {
    args.push("--parent-token", input.parentToken);
  }
  if (input.parentPosition) {
    args.push("--parent-position", input.parentPosition);
  }
  try {
    const { stdout, stderr } = await execFile("lark-cli", args, {
      cwd: tempDir,
      env: buildLarkCliChannelEnv(),
      maxBuffer: 10 * 1024 * 1024,
    });
    const parsed = parseLarkCliJson(stdout) as {
      ok?: boolean;
      data?: {
        document?: {
          title?: string;
          url?: string;
          document_id?: string;
          documentId?: string;
        };
        url?: string;
        permission_grant?: {
          status?: string;
          message?: string;
          hint?: string;
          required_scope?: string;
        };
      };
      error?: {
        message?: string;
      };
    };
    if (parsed.ok === false) {
      throw new Error(parsed.error?.message ?? "lark-cli docs +create failed");
    }
    const document = parsed.data?.document;
    return {
      title: document?.title ?? input.title,
      url: document?.url ?? parsed.data?.url,
      documentId: document?.document_id ?? document?.documentId,
      warning: renderLarkDocumentCreateWarning(parsed.data?.permission_grant, stderr),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

function renderLarkDocumentCreateWarning(
  grant: {
    status?: string;
    message?: string;
    hint?: string;
    required_scope?: string;
  } | undefined,
  stderr: string,
): string | undefined {
  if (grant?.status && grant.status !== "success") {
    return [
      `permission_grant=${grant.status}`,
      grant.required_scope ? `required_scope=${grant.required_scope}` : undefined,
      grant.message,
      grant.hint,
    ].filter((line): line is string => Boolean(line?.trim())).join(" ");
  }
  const warning = stderr.split(/\r?\n/).map((line) => line.trim()).find((line) => /^Warning:/i.test(line));
  return warning || undefined;
}

export function parseLarkDocumentCreateInput(payload: Record<string, unknown> | null): LarkDocumentCreateInput {
  if (!payload || typeof payload.content !== "string" || payload.content.trim().length === 0) {
    throw new Error("lark.doc.create requires payload.content");
  }
  const docFormat = payload.docFormat === "markdown" || payload.format === "markdown"
    ? "markdown"
    : payload.docFormat === "xml" || payload.format === "xml"
      ? "xml"
      : undefined;
  const as = payload.as === "bot" ? "bot" : payload.as === "user" ? "user" : undefined;
  return {
    content: payload.content,
    ...(typeof payload.title === "string" ? { title: payload.title } : {}),
    ...(docFormat ? { docFormat } : {}),
    ...(as ? { as } : {}),
    ...(typeof payload.parentToken === "string" ? { parentToken: payload.parentToken } : {}),
    ...(typeof payload.parentPosition === "string" ? { parentPosition: payload.parentPosition } : {}),
  };
}

function parseLarkCliJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("lark-cli docs +create returned empty output");
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Some lark-cli commands print human-readable headers before the JSON body.
  }

  const jsonStart = trimmed.lastIndexOf("\n{");
  if (jsonStart !== -1) {
    const candidate = trimmed.slice(jsonStart + 1);
    return JSON.parse(candidate) as unknown;
  }

  const firstBrace = trimmed.indexOf("{");
  if (firstBrace !== -1) {
    return JSON.parse(trimmed.slice(firstBrace)) as unknown;
  }

  throw new Error("lark-cli docs +create did not return JSON output");
}

function inferDocFormat(content: string): "xml" | "markdown" {
  return /^\s*</.test(content) ? "xml" : "markdown";
}

function resolveDefaultLarkDocumentActor(): "user" | "bot" {
  const value = process.env.CCTB_LARK_DOC_CREATE_AS ?? process.env.LARK_DOC_CREATE_AS;
  return value?.trim().toLowerCase() === "user" ? "user" : "bot";
}
