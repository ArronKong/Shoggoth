// Reassemble complete native messages before any delta/final state mutation.
// This store is per socket and carries no owner, renderer or action authority.
export function createNativeChatFrameAssembler(now = Date.now) {
  const pending = new Map<string, { sha256: string; byteLength: number; count: number; chunks: Uint8Array[]; received: number; expiresAt: number }>();
  const max = 8 * 1024 * 1024;
  return {
    clear() { pending.clear(); },
    async accept(frame: any): Promise<any | null> {
      if (frame?.type !== "event" || frame.event !== "chat.native.fragment") return frame;
      for (const [id, record] of pending) if (record.expiresAt <= now()) pending.delete(id);
      const p = frame.payload;
      const keys = ["version", "transferId", "sha256", "byteLength", "index", "count", "data"];
      if (!p || Object.keys(p).length !== keys.length || keys.some(key => !Object.hasOwn(p, key))
        || p.version !== 1 || !/^[a-f0-9-]{36}$/.test(p.transferId) || !/^[a-f0-9]{64}$/.test(p.sha256)
        || !Number.isSafeInteger(p.byteLength) || p.byteLength < 1 || p.byteLength > max
        || !Number.isSafeInteger(p.count) || p.count < 2 || p.count > 256
        || !Number.isSafeInteger(p.index) || p.index < 0 || p.index >= p.count
        || typeof p.data !== "string" || p.data.length > 44000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.data)) throw new Error("交互消息分片无效");
      let record = pending.get(p.transferId);
      if (!record) {
        if (p.index !== 0 || pending.size >= 2) throw new Error("交互消息分片不完整");
        record = { sha256: p.sha256, byteLength: p.byteLength, count: p.count, chunks: [], received: 0, expiresAt: now() + 30000 };
        pending.set(p.transferId, record);
      }
      if (record.sha256 !== p.sha256 || record.byteLength !== p.byteLength || record.count !== p.count || p.index !== record.chunks.length) {
        pending.delete(p.transferId); throw new Error("交互消息分片身份不一致");
      }
      const decoded = Uint8Array.from(atob(p.data), char => char.charCodeAt(0));
      record.received += decoded.byteLength;
      if (decoded.byteLength > 32768 || record.received > record.byteLength) { pending.delete(p.transferId); throw new Error("交互消息分片超出容量"); }
      record.chunks.push(decoded);
      if (record.chunks.length < record.count) return null;
      pending.delete(p.transferId);
      if (record.received !== record.byteLength) throw new Error("交互消息分片不完整");
      const bytes = new Uint8Array(record.received); let offset = 0;
      for (const chunk of record.chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(n => n.toString(16).padStart(2, "0")).join("");
      if (digest !== record.sha256) throw new Error("交互消息校验失败");
      const output = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!(output?.payload?.message?.shoggoth?.nativeUiVersion === 1
        || output?.payload?.messages?.some((message: any) => message?.shoggoth?.nativeUiVersion === 1))) throw new Error("交互消息类型无效");
      return output;
    },
  };
}
