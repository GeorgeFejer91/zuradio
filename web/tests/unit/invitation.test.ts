import { describe, expect, it } from "vitest";

import { parseInvitation } from "../../src/invitation";

describe("companion invitation", () => {
  it("parses a bounded password-gated listener fragment", () => {
    const invitation = parseInvitation(
      "#v=2&mode=listen&session=session&epoch=4&room=room&stream=stream&transportKey=secret&passwordSalt=c2FsdA&passwordIterations=210000",
    );
    expect(invitation).toMatchObject({
      mode: "listen",
      session: "session",
      epoch: 4,
      controllerRoom: "room",
      controllerStream: "stream",
      controllerTransportKey: "secret",
      passwordIterations: 210000,
    });
  });

  it("rejects an incomplete controller fragment", () => {
    expect(() =>
      parseInvitation(
        "#v=2&mode=control&session=session&epoch=4&passwordSalt=c2FsdA&passwordIterations=210000",
      ),
    ).toThrow(/missing room/i);
  });

  it("rejects oversized fragments", () => {
    expect(() => parseInvitation(`#${"a".repeat(5000)}`)).toThrow(/too long/i);
  });
});
