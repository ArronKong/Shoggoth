// 首版只开放本机连接；远程实现与已有配置保留，入口统一关闭。
export const REMOTE_CONNECTIONS_ENABLED = false;

export function isLocalGatewayUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "ws:" || url.protocol === "wss:")
      && !url.username && !url.password
      && (url.hostname === "localhost" || url.hostname === "[::1]"
        || /^127(?:\.\d{1,3}){3}$/.test(url.hostname));
  } catch {
    return false;
  }
}
