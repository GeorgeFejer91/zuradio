export interface ChatLimits {
  maxCharacters: number;
  maxBytes: number;
}

export interface ChatTextMetrics {
  characters: number;
  bytes: number;
}

export const LONG_CHAT_LIMITS: ChatLimits = {
  maxCharacters: 64 * 1024,
  maxBytes: 64 * 1024,
};

export const LEGACY_CHAT_LIMITS: ChatLimits = {
  maxCharacters: 300,
  maxBytes: 320,
};

const encoder = new TextEncoder();

export function chatTextMetrics(text: string): ChatTextMetrics {
  return {
    characters: Array.from(text).length,
    bytes: encoder.encode(text).length,
  };
}

export function chatTextFits(text: string, limits: ChatLimits): boolean {
  const metrics = chatTextMetrics(text);
  return Boolean(text.trim())
    && metrics.characters <= limits.maxCharacters
    && metrics.bytes <= limits.maxBytes;
}

export function chatCounterText(text: string, limits: ChatLimits): string {
  const metrics = chatTextMetrics(text);
  return `${formatCount(metrics.characters)} / ${formatCount(limits.maxCharacters)} characters · ${formatCount(metrics.bytes)} / ${formatCount(limits.maxBytes)} UTF-8 bytes`;
}

export function chatLimitError(text: string, limits: ChatLimits): string {
  const metrics = chatTextMetrics(text);
  if (metrics.characters > limits.maxCharacters || metrics.bytes > limits.maxBytes) {
    return `Messages are limited to ${formatCount(limits.maxCharacters)} characters and ${formatCount(limits.maxBytes)} UTF-8 bytes.`;
  }
  return "";
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}
