export const SUPPORTED_AUDIO_EXTENSIONS = [
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
] as const;

const supportedAudioExtensions = new Set<string>(SUPPORTED_AUDIO_EXTENSIONS);

export const SUPPORTED_AUDIO_ACCEPT = [
  "audio/*",
  ...SUPPORTED_AUDIO_EXTENSIONS.map((extension) => `.${extension}`),
].join(",");

export function isSupportedAudioFileName(name: string): boolean {
  const extension = name.split(".").pop()?.toLocaleLowerCase("en-US") ?? "";
  return supportedAudioExtensions.has(extension);
}
