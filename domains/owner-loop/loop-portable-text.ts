import type { LoopPortableText } from './loop-portable-types.js';

export const DEFAULT_LOOP_PORTABLE_TEXT_BYTES = 16 * 1024;

function assertByteBudget(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error('Loop portable text byte budget must be a non-negative safe integer');
  }
}

/**
 * Keep a UTF-8-safe diagnostic preview. This budget applies only to display text;
 * callers must never pass IDs, enums, counters, paths, or acceptance collections here.
 */
export function toLoopPortableText(
  value: string,
  maxBytes = DEFAULT_LOOP_PORTABLE_TEXT_BYTES,
): LoopPortableText {
  if (typeof value !== 'string') throw new Error('Loop portable text must be a string');
  assertByteBudget(maxBytes);
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false };

  let text = '';
  let bytes = 0;
  for (const character of value) {
    const width = Buffer.byteLength(character, 'utf8');
    if (bytes + width > maxBytes) break;
    text += character;
    bytes += width;
  }
  return { text, truncated: true };
}
