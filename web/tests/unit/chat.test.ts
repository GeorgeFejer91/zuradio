import { describe, expect, it } from "vitest";

import {
  chatCounterText,
  chatLimitError,
  chatTextFits,
  chatTextMetrics,
  LONG_CHAT_LIMITS,
} from "../../src/chat";

describe("chat message limits", () => {
  it("accepts exactly 64 KiB of multiline UTF-8 text", () => {
    const message = (`plan\n${"checkpoint\n".repeat(6_000)}`).slice(0, 65_535) + "Z";

    expect(chatTextMetrics(message)).toEqual({ characters: 65_536, bytes: 65_536 });
    expect(chatTextFits(message, LONG_CHAT_LIMITS)).toBe(true);
    expect(chatLimitError(message, LONG_CHAT_LIMITS)).toBe("");
    expect(chatCounterText(message, LONG_CHAT_LIMITS)).toBe(
      "65,536 / 65,536 characters · 65,536 / 65,536 UTF-8 bytes",
    );
  });

  it("rejects multi-byte text beyond the byte cap even below the character cap", () => {
    const message = "🙂".repeat(16_385);

    expect(chatTextMetrics(message)).toEqual({ characters: 16_385, bytes: 65_540 });
    expect(chatTextFits(message, LONG_CHAT_LIMITS)).toBe(false);
    expect(chatLimitError(message, LONG_CHAT_LIMITS)).toContain("65,536 UTF-8 bytes");
  });
});
