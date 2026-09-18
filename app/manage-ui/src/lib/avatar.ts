// Client-side avatar helpers: downscale a user-picked image to a small square
// PNG, then upload it to the loopback /avatar/<id> store (static-server writes
// it to Shoggoth's userData/agent-avatars/<id>.png and serves it back on GET).

// 最大消费者是 Agents 页 320px 见方的卡片大图：Retina(DPR2) 要 640 物理像素，
// 原值 256 只有四成分辨率、被放大 2.5 倍 → 肉眼可见的糊。768 覆盖到 DPR3 的多数
// 场景，且按实测最坏样本外推仍在 static-server 的 3MB 上限内（1024 会顶到线上）。
const AVATAR_SIZE = 768;

// Center-crop `file` to a square and downscale to `size` px, returning a PNG
// blob. 聊天列表的小圆头像用同一份文件，靠浏览器缩放，不再单独出一份。
export async function resizeToSquarePng(file: File, size = AVATAR_SIZE): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    // 默认 "low" 在大幅下采样时会丢边缘细节（多数上传源图是 2K+）。
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("toBlob returned null");
    return blob;
  } finally {
    bitmap.close();
  }
}

// Upload a PNG blob as `agentId`'s avatar. Throws on a non-2xx response.
export async function uploadAvatar(agentId: string, blob: Blob): Promise<void> {
  const res = await fetch(`/avatar/${encodeURIComponent(agentId)}`, {
    method: "PUT",
    headers: { "Content-Type": "image/png" },
    body: blob,
  });
  if (!res.ok) {
    let msg = String(res.status);
    try {
      const j = (await res.json()) as { error?: string };
      if (j && j.error) msg = j.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }
}
