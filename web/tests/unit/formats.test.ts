import { describe, expect, it } from "vitest";

import {
  isSupportedAudioFileName,
  SUPPORTED_AUDIO_ACCEPT,
  SUPPORTED_AUDIO_EXTENSIONS,
} from "../../src/formats";

describe("audio format matrix", () => {
  it("accepts every catalog and upload format case-insensitively", () => {
    expect(SUPPORTED_AUDIO_EXTENSIONS).toEqual([
      "aac",
      "aif",
      "aiff",
      "alac",
      "flac",
      "m4a",
      "mp3",
      "mp4",
      "ogg",
      "opus",
      "wav",
      "webm",
    ]);
    for (const extension of SUPPORTED_AUDIO_EXTENSIONS) {
      expect(isSupportedAudioFileName(`album/track.${extension}`)).toBe(true);
      expect(isSupportedAudioFileName(`TRACK.${extension.toUpperCase()}`)).toBe(true);
      expect(SUPPORTED_AUDIO_ACCEPT).toContain(`.${extension}`);
    }
  });

  it("rejects files outside the audio allowlist", () => {
    for (const name of ["cover.jpg", "notes.txt", "track", "track.flac.exe"]) {
      expect(isSupportedAudioFileName(name)).toBe(false);
    }
  });
});
