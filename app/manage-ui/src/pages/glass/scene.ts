// Draws a media frame (video or image) onto a 2D context with object-fit:cover, so the
// WebGL refraction texture matches a cover-fitted background element exactly. Both the
// visible element and this texture cover-fit the same source into the same box, so the
// glass refracts precisely what's on screen. Returns false if the source has no pixels yet.

export type MediaSource = HTMLVideoElement | HTMLImageElement;

export function drawMediaCover(ctx: CanvasRenderingContext2D, source: MediaSource, w: number, h: number): boolean {
  const isVideo = source instanceof HTMLVideoElement;
  const sw = isVideo ? source.videoWidth : source.naturalWidth;
  const sh = isVideo ? source.videoHeight : source.naturalHeight;
  if (!sw || !sh) return false;
  const scale = Math.max(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  ctx.drawImage(source, (w - dw) / 2, (h - dh) / 2, dw, dh);
  return true;
}

// 兼容旧名（GlassLab 实验页仍用视频专用签名）。
export function drawVideoCover(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, w: number, h: number): boolean {
  return drawMediaCover(ctx, video, w, h);
}
