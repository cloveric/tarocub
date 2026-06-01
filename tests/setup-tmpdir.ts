import { mkdirSync } from "node:fs";
import os from "node:os";

/**
 * Vitest global setup: guard against a very long inherited TMPDIR.
 *
 * In nested agent / CI environments the temp dir can be hundreds of chars deep
 * (e.g. `/tmp/x/x/x/…`). Tests that build deep paths — notably the Codex
 * rollout-depth test, which nests 32 `level-N/` dirs to exercise the scan cap —
 * then blow past the OS path limit (`ENAMETOOLONG`; unix sockets hit `EINVAL` at
 * 104 chars), producing spurious `npm test` failures that look like an unclean
 * release. Redirect to a short, stable base so the suite is robust regardless of
 * the ambient TMPDIR. POSIX only — on Windows the temp path is already short, and
 * `/tmp` is not a valid base there.
 */
if (process.platform !== "win32") {
  const current = process.env.TMPDIR ?? os.tmpdir();
  if (current.length > 64) {
    const short = "/tmp/cctb-test-tmp";
    mkdirSync(short, { recursive: true });
    process.env.TMPDIR = short;
  }
}
