import { execFile } from "node:child_process";

export interface LarkCliStatus {
  available: boolean;
  version?: string;
  error?: string;
}

export type LarkCliExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

const LARK_CLI_STATUS_TIMEOUT_MS = 3_000;

export async function detectLarkCliStatus(execFileImpl: LarkCliExecFile = defaultExecFile): Promise<LarkCliStatus> {
  try {
    const { stdout, stderr } = await execFileImpl("lark-cli", ["--version"], {
      timeout: LARK_CLI_STATUS_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
    const output = `${bufferToString(stdout)}\n${bufferToString(stderr)}`.trim();
    const version = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return {
      available: true,
      ...(version ? { version } : {}),
    };
  } catch (error) {
    return {
      available: false,
      error: renderLarkCliError(error),
    };
  }
}

function defaultExecFile(
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({
        stdout: bufferToString(stdout),
        stderr: bufferToString(stderr),
      });
    });
  });
}

function bufferToString(value: string | Buffer): string {
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

function renderLarkCliError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
