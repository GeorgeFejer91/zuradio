import type { CompanionInvitation } from "./types";

export function parseInvitation(fragment: string): CompanionInvitation {
  if (fragment.length > 4096) throw new Error("Invitation is too long");
  const parameters = new URLSearchParams(fragment.replace(/^#/, ""));
  const version = required(parameters, "v", 4);
  if (version !== "2") throw new Error("Unsupported invitation version");
  const mode = required(parameters, "mode", 16);
  if (mode !== "listen" && mode !== "control" && mode !== "upload") {
    throw new Error("Invalid invitation mode");
  }
  const session = required(parameters, "session", 64);
  const epoch = Number(required(parameters, "epoch", 32));
  if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error("Invalid broadcast epoch");
  const passwordIterations = Number(required(parameters, "passwordIterations", 12));
  if (!Number.isSafeInteger(passwordIterations) || passwordIterations < 100_000 || passwordIterations > 1_000_000) {
    throw new Error("Invalid password work factor");
  }
  return {
    version: "2",
    mode,
    session,
    epoch,
    controllerRoom: required(parameters, "room", 128),
    controllerStream: required(parameters, "stream", 128),
    controllerTransportKey: required(parameters, "transportKey", 256),
    passwordSalt: required(parameters, "passwordSalt", 128),
    passwordIterations,
  };
}

function required(parameters: URLSearchParams, key: string, max: number): string {
  const value = parameters.get(key);
  if (!value || value.length > max) throw new Error(`Invitation is missing ${key}`);
  return value;
}
