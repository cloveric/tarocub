import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.claude/worktrees/**"],
    // Runs before each test file: normalizes a too-long inherited TMPDIR so
    // deep-path tests don't spuriously fail. See tests/setup-tmpdir.ts.
    setupFiles: ["./tests/setup-tmpdir.ts"],
  },
});
