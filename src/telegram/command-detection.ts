export function isResetCommand(text: string): boolean {
  return /^\/reset(?:@\w+)?(?:\s|$)/i.test(text.trim());
}
