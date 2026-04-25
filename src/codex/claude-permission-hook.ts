import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { EngineApprovalDecision, EngineApprovalRequest } from "./adapter.js";

export const CLAUDE_PERMISSION_HOOK_PATH = "/claude-permission";
export const CLAUDE_PERMISSION_MCP_SERVER_NAME = "cctb_approval";
export const CLAUDE_PERMISSION_MCP_TOOL_NAME = "mcp__cctb_approval__approve";

export interface ClaudePermissionHookInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  toolName?: string;
  input?: unknown;
  tool_input?: unknown;
  toolInput?: unknown;
  tool_use_id?: string;
}

export interface ClaudePermissionHookServer {
  url: string;
  close(): Promise<void>;
}

type ClaudePermissionMcpConfig = {
  mcpServers: {
    cctb_approval: {
      type: "stdio";
      command: string;
      args: string[];
      env: {
        CCTB_CLAUDE_APPROVAL_URL: string;
      };
    };
  };
};

export interface ClaudePermissionMcpServerInvocation {
  command: string;
  args: string[];
}

export function resolveClaudePermissionMcpServerInvocation(): ClaudePermissionMcpServerInvocation {
  const jsPath = fileURLToPath(new URL("./claude-permission-mcp-server.js", import.meta.url));
  if (existsSync(jsPath)) {
    return {
      command: process.execPath,
      args: [jsPath],
    };
  }

  const tsPath = fileURLToPath(new URL("./claude-permission-mcp-server.ts", import.meta.url));
  const localTsx = path.resolve(process.cwd(), "node_modules/.bin/tsx");
  if (existsSync(tsPath) && existsSync(localTsx)) {
    return {
      command: localTsx,
      args: [tsPath],
    };
  }

  return {
    command: process.execPath,
    args: [jsPath],
  };
}

export function createClaudePermissionMcpConfig(input: ClaudePermissionMcpServerInvocation & {
  approvalUrl: string;
}): ClaudePermissionMcpConfig {
  return {
    mcpServers: {
      cctb_approval: {
        type: "stdio",
        command: input.command,
        args: input.args,
        env: {
          CCTB_CLAUDE_APPROVAL_URL: input.approvalUrl,
        },
      },
    },
  };
}

export function renderClaudePermissionPromptToolResponse(
  decision: EngineApprovalDecision,
  input: Pick<ClaudePermissionHookInput, "input" | "tool_input" | "toolInput">,
): Record<string, unknown> {
  if (decision.behavior === "deny") {
    return {
      behavior: "deny",
      message: "Denied from Telegram.",
    };
  }

  return {
    behavior: "allow",
    updatedInput: input.input ?? input.tool_input ?? input.toolInput ?? {},
  };
}

function readRequestJson(request: IncomingMessage): Promise<ClaudePermissionHookInput> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        request.destroy(new Error("Permission hook request body exceeded 1 MiB"));
      }
    });
    request.on("error", reject);
    request.on("end", () => {
      try {
        resolve(body.trim() ? JSON.parse(body) as ClaudePermissionHookInput : {});
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

function writeJson(response: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Connection": "close",
  });
  response.end(body);
}

function toEngineApprovalRequest(input: ClaudePermissionHookInput, abortSignal?: AbortSignal): EngineApprovalRequest {
  const toolName = input.tool_name ?? input.toolName;
  return {
    engine: "claude",
    toolName: typeof toolName === "string" && toolName.trim()
      ? toolName
      : "Unknown tool",
    toolInput: input.input ?? input.tool_input ?? input.toolInput ?? {},
    cwd: typeof input.cwd === "string" ? input.cwd : undefined,
    sessionId: typeof input.session_id === "string" ? input.session_id : undefined,
    abortSignal,
  };
}

function sessionApprovalKey(input: ClaudePermissionHookInput): string {
  const request = toEngineApprovalRequest(input);
  return `${request.toolName}:${JSON.stringify(request.toolInput)}`;
}

export async function startClaudePermissionHookServer(
  onApprovalRequest: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>,
): Promise<ClaudePermissionHookServer> {
  const sessionApprovedKeys = new Set<string>();
  const approvalAbortController = new AbortController();

  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== CLAUDE_PERMISSION_HOOK_PATH) {
      writeJson(response, 404, { error: "not found" });
      return;
    }

    let input: ClaudePermissionHookInput;
    try {
      input = await readRequestJson(request);
    } catch (error) {
      writeJson(response, 200, renderClaudePermissionPromptToolResponse({ behavior: "deny" }, {}));
      return;
    }

    try {
      const key = sessionApprovalKey(input);
      if (sessionApprovedKeys.has(key)) {
        writeJson(response, 200, renderClaudePermissionPromptToolResponse({ behavior: "allow", scope: "session" }, input));
        return;
      }

      const decision = await onApprovalRequest(toEngineApprovalRequest(input, approvalAbortController.signal));
      if (decision.behavior === "allow" && decision.scope === "session") {
        sessionApprovedKeys.add(key);
      }
      writeJson(response, 200, renderClaudePermissionPromptToolResponse(decision, input));
    } catch {
      writeJson(response, 200, renderClaudePermissionPromptToolResponse({ behavior: "deny" }, input));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address.port !== "number") {
    await closeServer(server);
    throw new Error("Failed to start Claude permission hook server");
  }

  return {
    url: `http://127.0.0.1:${address.port}${CLAUDE_PERMISSION_HOOK_PATH}`,
    close: async () => {
      approvalAbortController.abort();
      await closeServer(server);
    },
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
