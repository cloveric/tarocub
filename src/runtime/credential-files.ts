import path from "node:path";

const CREDENTIAL_FILE_NAME_PATTERNS: RegExp[] = [
  /^\.env(?:\.|$)/i,
  /^id_rsa$/i,
  /^id_ed25519$/i,
  /\.pem$/i,
  /\.key$/i,
];

export function isCredentialStyleFileName(fileName: string): boolean {
  return CREDENTIAL_FILE_NAME_PATTERNS.some((pattern) => pattern.test(fileName));
}

export function isCredentialStylePath(...filePaths: Array<string | undefined>): boolean {
  return filePaths.some((filePath) => Boolean(filePath) && isCredentialStyleFileName(path.basename(filePath!)));
}
