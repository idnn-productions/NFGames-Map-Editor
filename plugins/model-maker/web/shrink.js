// An image file from the user's disk as a JPEG data URL small enough for a request (a plugin route takes 2 MB): the
// longest side at most 2048 px, the quality stepped down until it fits.
const MAX_SIDE = 2048, MAX_CHARS = 1.8 * 1024 * 1024;

export async function shrink(file) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error(`${file.name}: a PNG, JPEG or WebP image`);
  const bitmap = await createImageBitmap(file), k = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(bitmap.width * k)), height: Math.max(1, Math.round(bitmap.height * k)) });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);   // JPEG has no see-through: white behind
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close?.();
  for (const quality of [0.9, 0.8, 0.7, 0.55, 0.4]) { const url = canvas.toDataURL('image/jpeg', quality); if (url.length <= MAX_CHARS) return url; }
  throw new Error(`${file.name}: too large even when shrunk`);
}
