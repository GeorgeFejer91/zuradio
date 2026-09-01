const PASSWORD_ITERATIONS = 210_000;
const RENDEZVOUS_SALT = "zuradio-rendezvous-v1|georgefejer91-zuradio";

export interface RendezvousRoute {
  room: string;
  stream: string;
  transportKey: string;
}

export async function deriveRendezvousRoute(password: string): Promise<RendezvousRoute> {
  const encoded = new TextEncoder().encode(password);
  if (encoded.length < 8 || encoded.length > 256) throw new Error("Password must contain 8 to 256 bytes");
  const material = await crypto.subtle.importKey("raw", encoded, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new TextEncoder().encode(RENDEZVOUS_SALT),
      iterations: PASSWORD_ITERATIONS,
    },
    material,
    256,
  );
  encoded.fill(0);
  const key = await crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const component = async (label: string): Promise<string> => {
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(label));
    return base64Url(new Uint8Array(signature));
  };
  return {
    room: await component("room"),
    stream: await component("stream"),
    transportKey: await component("transport"),
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
