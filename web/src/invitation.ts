import type { CompanionInvitation } from "./types";

export function parseInvitation(fragment: string): CompanionInvitation {
  if (fragment.length > 4096) throw new Error("Invitation is too long");
  const parameters = new URLSearchParams(fragment.replace(/^#/, ""));
  const version = required(parameters, "v", 4);
  if (version !== "1") throw new Error("Unsupported invitation version");
  const role = required(parameters, "role", 16);
  if (role !== "listener" && role !== "controller") throw new Error("Invalid invitation role");
  const session = required(parameters, "session", 64);
  const epoch = Number(required(parameters, "epoch", 32));
  if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error("Invalid broadcast epoch");
  const listener = role === "listener";
  return {
    version: "1",
    role,
    session,
    epoch,
    listenRoom: required(parameters, listener ? "room" : "listenRoom", 128),
    listenStream: required(parameters, listener ? "stream" : "listenStream", 128),
    listenTransportKey: required(parameters, listener ? "transportKey" : "listenTransportKey", 256),
    controllerRoom: listener ? undefined : required(parameters, "room", 128),
    controllerStream: listener ? undefined : required(parameters, "stream", 128),
    controllerTransportKey: listener ? undefined : required(parameters, "transportKey", 256),
    pairingKey: listener ? undefined : required(parameters, "pairingKey", 256),
  };
}

function required(parameters: URLSearchParams, key: string, max: number): string {
  const value = parameters.get(key);
  if (!value || value.length > max) throw new Error(`Invitation is missing ${key}`);
  return value;
}
