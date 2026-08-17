// Food-image optimisation for the Menu Builder - ported from the web app's
// `src/lib/image.ts` so both clients write the SAME artefacts to the SAME bucket.
//
// The output contract is what matters, and it is copied exactly: one MAIN image
// capped at 1200px and one THUMBNAIL capped at 400px, both WebP at quality 0.8
// (JPEG where the engine cannot encode WebP), aspect ratio preserved. The
// desktop uploads them to `menu-images/<tenant_id>/<item_id>/…`, the same path
// scheme the web app uses, so an image uploaded from a till is indistinguishable
// from one uploaded in a browser - including to the public E-Menu that reads it.
//
// Pure browser APIs (createImageBitmap / canvas), no dependency, and nothing
// here touches Supabase - the upload itself lives in `repository.ts`.

export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAIN_IMAGE_WIDTH = 1200;
export const THUMB_IMAGE_WIDTH = 400;
export const IMAGE_QUALITY = 0.8;
export const MENU_IMAGE_BUCKET = "menu-images";

export type OptimizedImage = { blob: Blob; width: number; height: number; ext: "webp" | "jpg"; contentType: string };
export type OptimizedPair = { main: OptimizedImage; thumb: OptimizedImage };

/** A user-friendly reason the file is not an acceptable image, or null. */
export function validateImageFile(file: { type: string; size: number }): string | null {
  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return "Please choose a JPG, PNG or WebP image.";
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return "Image is larger than 5 MB. Please choose a smaller file.";
  }
  return null;
}

/** Storage path for one optimised image. Cache-busted so a replacement is not served stale. */
export function menuImagePath(tenantId: string, itemKey: string, kind: "main" | "thumb", ext: string, bust: number) {
  return `${tenantId}/${itemKey}/${kind}-${bust}.${ext}`;
}

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through to <img> decode */
    }
  }
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not read this image."));
    img.src = URL.createObjectURL(file);
  });
}

function dims(src: ImageBitmap | HTMLImageElement): { w: number; h: number } {
  const w = (src as ImageBitmap).width || (src as HTMLImageElement).naturalWidth;
  const h = (src as ImageBitmap).height || (src as HTMLImageElement).naturalHeight;
  return { w, h };
}

async function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

async function resize(src: ImageBitmap | HTMLImageElement, maxWidth: number, quality: number): Promise<OptimizedImage> {
  const { w, h } = dims(src);
  const scale = Math.min(1, maxWidth / Math.max(1, w));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This terminal cannot process images.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src as CanvasImageSource, 0, 0, tw, th);
  let blob = await encode(canvas, "image/webp", quality);
  if (!blob || blob.type !== "image/webp") blob = await encode(canvas, "image/jpeg", quality);
  if (!blob) throw new Error("Image encoding failed.");
  const isWebp = blob.type === "image/webp";
  return { blob, width: tw, height: th, ext: isWebp ? "webp" : "jpg", contentType: blob.type };
}

/** Produce { main, thumb } optimised images from a validated file. */
export async function optimizeMenuImage(file: File): Promise<OptimizedPair> {
  const src = await decode(file);
  const main = await resize(src, MAIN_IMAGE_WIDTH, IMAGE_QUALITY);
  const thumb = await resize(src, THUMB_IMAGE_WIDTH, IMAGE_QUALITY);
  if ("close" in src && typeof (src as ImageBitmap).close === "function") (src as ImageBitmap).close();
  return { main, thumb };
}
