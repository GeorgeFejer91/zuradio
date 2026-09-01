import { describe, expect, it } from "vitest";

import { parseInvitation } from "../../src/invitation";

describe("companion invitation", () => {
  it("parses a bounded listener fragment", () => {
    const invitation = parseInvitation(
      "#v=1&role=listener&session=session&epoch=4&room=room&stream=stream&transportKey=secret",
    );
    expect(invitation).toMatchObject({
      role: "listener",
      session: "session",
      epoch: 4,
      listenRoom: "room",
      listenStream: "stream",
      listenTransportKey: "secret",
    });
    expect(invitation.pairingKey).toBeUndefined();
  });

  it("rejects an incomplete controller fragment", () => {
    expect(() =>
      parseInvitation(
        "#v=1&role=controller&session=session&epoch=4&listenRoom=a&listenStream=b&listenTransportKey=c",
      ),
    ).toThrow(/missing room/i);
  });

  it("rejects oversized fragments", () => {
    expect(() => parseInvitation(`#${"a".repeat(5000)}`)).toThrow(/too long/i);
  });
});
