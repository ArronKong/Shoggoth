import type { ChatReadState } from "../../app/manage-ui/src/types";

export const CHAT_READ_STATE_FIXTURE_INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";

/** Isolated App-owned presentation state, separate from browser storage. */
export function createChatReadStateFixture(since: number, initialRead: Record<string, number> = {}) {
  const shared: ChatReadState = { version: 1, installationId: CHAT_READ_STATE_FIXTURE_INSTALLATION_ID,
    since, revision: 0, read: { ...initialRead } };
  return (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://fixture");
    if (url.pathname !== "/__api/chat-read-state") return null;
    if (init.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.installationId !== shared.installationId) throw Error("Wrong fixture installation");
      for (const [key, at] of Object.entries(body.read) as [string, number][]) {
        if (at > Math.max(shared.since, shared.read[key] || 0)) { shared.read[key] = at; shared.revision++; }
      }
    }
    const unchanged = !init.method && url.searchParams.get("installationId") === shared.installationId
      && url.searchParams.get("revision") === String(shared.revision);
    return new Response(JSON.stringify({ state: unchanged ? null : shared }), { headers: { "Content-Type": "application/json" } });
  };
}
