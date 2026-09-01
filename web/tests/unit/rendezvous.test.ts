import { describe, expect, it } from "vitest";

import { deriveRendezvousRoute } from "../../src/rendezvous";

describe("password rendezvous", () => {
  it("matches the Rust route fixture exactly", async () => {
    await expect(deriveRendezvousRoute("a-long-test-password")).resolves.toEqual({
      room: "5UFNZ02OXYjjziKttJgsh8cUfLnvc6VxwLbKvbl36s4",
      stream: "5RQiiZWIVPGFyJG29PIHWPZQZUjVXv8RPLdOkrQTOo8",
      transportKey: "NyPZYj4WqcG63U708i6bw35Mclif3LIJ7kHVw75EUEw",
    });
  });

  it("rejects short passwords before opening any transport", async () => {
    await expect(deriveRendezvousRoute("short")).rejects.toThrow("8 to 256 bytes");
  });
});
