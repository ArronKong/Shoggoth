export type ChatClipboardAttachment = {
  name: string;
  kind: "image" | "file";
  src?: string;
  preview?: string;
  path?: string;
};

type ClipboardFile = { fileName: string; mimeType: string; content: string };
type DesktopChatClipboard = {
  writeChatClipboard?: (value: { text: string; files: { name: string; bytes?: ArrayBuffer; path?: string }[]; png?: ArrayBuffer }) => Promise<void>;
  readChatClipboard?: (chatOnly: boolean) => Promise<{ files: ClipboardFile[]; caption?: string }>;
  readClipboardFiles?: () => Promise<ClipboardFile[]>;
};

const MAX_CLIPBOARD_BYTES = 50 * 1024 * 1024;
let copyRevision = 0;

export function desktopChatClipboard() {
  return (window as Window & { openclawDesktop?: DesktopChatClipboard }).openclawDesktop;
}

export function clipboardFile(item: ClipboardFile): File {
  const bytes = Uint8Array.from(atob(item.content), value => value.charCodeAt(0));
  return new File([bytes], item.fileName, { type: item.mimeType });
}

async function attachmentBlob(src: string, limit = MAX_CLIPBOARD_BYTES): Promise<Blob> {
  if (!src.startsWith("data:") && !/^\/(?:__api\/inspirations\/media|__media)\?/.test(src)) {
    throw new Error("Invalid attachment source");
  }
  const response = await fetch(src);
  if (!response.ok || Number(response.headers.get("Content-Length")) > limit) throw new Error("Attachment unavailable");
  const blob = await response.blob();
  if (blob.size > limit) throw new Error("Clipboard attachments are too large");
  return blob;
}

async function imagePng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const image = await createImageBitmap(blob);
  try {
    if (image.width * image.height > 32 * 1024 * 1024) throw new Error("Clipboard image is too large");
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion unavailable");
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      value => value ? resolve(value) : reject(new Error("Image conversion failed")), "image/png"));
  } finally { image.close(); }
}

/** Commit all available representations together. A later copy supersedes a pending fetch. */
export async function writeChatClipboard(text: string, attachments: readonly ChatClipboardAttachment[] = [],
  current: () => boolean = () => true): Promise<boolean> {
  const revision = ++copyRevision;
  if (!current()) return false;
  if (!attachments.length) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const singleImage = attachments.length === 1 && attachments[0].kind === "image";
  const desktop = desktopChatClipboard();
  if (!desktop?.writeChatClipboard) {
    const src = singleImage ? attachments[0].preview ?? attachments[0].src : undefined;
    if (!src) throw new Error("File clipboard unavailable");
    const png = attachmentBlob(src).then(imagePng);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png, ...(text ? { "text/plain": new Blob([text]) } : {}) })]);
    return true;
  }
  if (attachments.length > 8) throw new Error("Too many clipboard attachments");
  const files: { name: string; bytes?: ArrayBuffer; path?: string }[] = [];
  let png: ArrayBuffer | undefined;
  let remaining = MAX_CLIPBOARD_BYTES;
  for (const attachment of attachments) {
    if (!attachment.src) {
      if (!attachment.path) throw new Error("Attachment unavailable");
      files.push({ name: attachment.name, path: attachment.path });
      continue;
    }
    const blob = await attachmentBlob(attachment.src, remaining);
    remaining -= blob.size;
    if (singleImage) {
      try {
        const preview = attachment.preview && attachment.preview !== attachment.src ? await attachmentBlob(attachment.preview) : blob;
        const image = await imagePng(preview);
        if (image.size <= MAX_CLIPBOARD_BYTES) png = await image.arrayBuffer();
      } catch { /* The original image is still available as a file. */ }
    }
    // A lone image has a native bitmap representation. A whole message also
    // includes the original files so a paste target can recover every attachment.
    if (!png || text) files.push({ name: attachment.name, bytes: await blob.arrayBuffer() });
  }
  if (revision !== copyRevision || !current()) return false;
  await desktop.writeChatClipboard({ text, files, png });
  return true;
}
