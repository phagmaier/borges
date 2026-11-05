/** Read raster dimensions without allocating a decoded bitmap. Both import's
 * isolated renderer and storage use this bound before decoding/publishing. */
export const MAX_COVER_BYTES = 10 * 1024 * 1024;
export function coverDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (bytes.length > MAX_COVER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  if (
    bytes.length >= 24 &&
    [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82].every(
      (n, i) => bytes[i] === n,
    )
  ) {
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    for (let at = 2; at + 4 <= bytes.length; ) {
      if (bytes[at++] !== 255) break;
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (
        marker === undefined ||
        marker === 218 ||
        marker === 217 ||
        at + 2 > bytes.length
      )
        break;
      const size = view.getUint16(at);
      if (size < 2 || at + size > bytes.length) break;
      if ([192, 193, 194].includes(marker) && size >= 8) {
        height = view.getUint16(at + 3);
        width = view.getUint16(at + 5);
        break;
      }
      at += size;
    }
  }
  return width > 0 &&
    height > 0 &&
    width <= 8192 &&
    height <= 8192 &&
    width * height <= 16_000_000
    ? { width, height }
    : null;
}
