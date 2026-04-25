type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
    protocolVersion?: string;
  };
};

function sendResponse(id: string | number | undefined, result: Record<string, unknown>): void {
  if (id === undefined) {
    return;
  }

  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    result,
  }) + "\n");
}

function sendError(id: string | number | undefined, code: number, message: string): void {
  if (id === undefined) {
    return;
  }

  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  }) + "\n");
}

async function resolvePermission(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const approvalUrl = process.env.CCTB_CLAUDE_APPROVAL_URL;
  if (!approvalUrl) {
    return {
      behavior: "deny",
      message: "Approval bridge is not configured.",
    };
  }

  try {
    const response = await fetch(approvalUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });

    if (!response.ok) {
      return {
        behavior: "deny",
        message: `Approval bridge returned HTTP ${response.status}.`,
      };
    }

    const payload = await response.json();
    if (typeof payload === "object" && payload !== null) {
      return payload as Record<string, unknown>;
    }
  } catch (error) {
    return {
      behavior: "deny",
      message: error instanceof Error ? error.message : "Approval bridge failed.",
    };
  }

  return {
    behavior: "deny",
    message: "Approval bridge returned an invalid response.",
  };
}

async function handleRequest(message: JsonRpcRequest): Promise<void> {
  if (message.method === "initialize") {
    sendResponse(message.id, {
      protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "cctb_approval",
        version: "1.0.0",
      },
    });
    return;
  }

  if (message.method === "tools/list") {
    sendResponse(message.id, {
      tools: [
        {
          name: "approve",
          description: "Ask the cc-telegram-bridge Telegram chat to approve or deny a Claude Code tool call.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: true,
          },
        },
      ],
    });
    return;
  }

  if (message.method === "tools/call") {
    if (message.params?.name !== "approve") {
      sendError(message.id, -32601, "Unknown tool");
      return;
    }

    const args = message.params.arguments ?? {};
    const decision = await resolvePermission(args);
    sendResponse(message.id, {
      content: [
        {
          type: "text",
          text: JSON.stringify(decision),
        },
      ],
    });
    return;
  }

  if (message.id !== undefined) {
    sendError(message.id, -32601, "Method not found");
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      continue;
    }
    void handleRequest(message).catch((error) => {
      sendError(message.id, -32603, error instanceof Error ? error.message : "Internal error");
    });
  }
});
