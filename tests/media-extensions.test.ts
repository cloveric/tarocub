import { describe, expect, it } from "vitest";

import {
  hasTranscribableAudioExtension,
  hasTranscribableMediaExtension,
  hasTranscribableVideoExtension,
} from "../src/runtime/media-extensions.js";

describe("transcribable media extensions", () => {
  it("accepts the recording containers people actually forward", () => {
    // The field case: a 24-minute meeting recording forwarded as a document.
    expect(hasTranscribableMediaExtension("吴毅飞豫园股份@180_1775_8921_20260811141335.m4a")).toBe(true);
    for (const name of ["a.mp3", "a.wav", "a.ogg", "a.opus", "a.aac", "a.flac", "a.amr", "a.wma",
      "a.aif", "a.m4b", "a.mka", "a.caf"]) {
      expect(hasTranscribableAudioExtension(name)).toBe(true);
      expect(hasTranscribableMediaExtension(name)).toBe(true);
    }
    for (const name of ["clip.mp4", "clip.mov", "clip.mkv", "clip.webm", "clip.m4v", "clip.avi",
      "clip.3gp", "clip.3gpp"]) {
      expect(hasTranscribableVideoExtension(name)).toBe(true);
      expect(hasTranscribableMediaExtension(name)).toBe(true);
    }
  });

  it("does not promote documents, images, or archives", () => {
    for (const name of ["report.docx", "sheet.xlsx", "deck.pptx", "a.pdf", "a.txt", "a.md",
      "photo.png", "photo.jpg", "bundle.zip", "code.ts", "a.json"]) {
      expect(hasTranscribableMediaExtension(name)).toBe(false);
    }
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(hasTranscribableMediaExtension("RECORDING.M4A")).toBe(true);
    expect(hasTranscribableMediaExtension("  meeting.MP3  ")).toBe(true);
    expect(hasTranscribableMediaExtension("/abs/path/with spaces/talk.Wav")).toBe(true);
  });

  it("ignores extension-like text that is not an extension", () => {
    expect(hasTranscribableMediaExtension("no-extension")).toBe(false);
    expect(hasTranscribableMediaExtension("")).toBe(false);
    // ".m4a" inside the stem, real extension is .txt
    expect(hasTranscribableMediaExtension("notes.m4a.txt")).toBe(false);
    // A directory-ish name must not match on a path segment
    expect(hasTranscribableMediaExtension("/tmp/audio.mp3/readme")).toBe(false);
  });
});
