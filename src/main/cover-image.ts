import { nativeImage } from "electron";
import { inspectCoverImage, invalidCover } from "../library/cover-image.ts";

/** Decode in main, after byte/dimension bounds, and store only a raster
 * thumbnail. No SVG markup, animation or source metadata reaches the UI. */
export function normalizeCover(bytes: Buffer): Buffer {
  const expected = inspectCoverImage(bytes);
  const image = nativeImage.createFromBuffer(bytes);
  const size = image.getSize();
  if (
    image.isEmpty() ||
    size.width !== expected.width ||
    size.height !== expected.height
  )
    throw invalidCover();
  const scale = Math.min(1, 512 / size.width, 768 / size.height);
  const thumbnail = image.resize({
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
    quality: "good",
  });
  return thumbnail.toPNG();
}
