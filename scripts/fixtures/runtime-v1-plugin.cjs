"use strict";
const { serveRuntimePlugin } = require("../../app/agent-service/runtime-plugin-sdk");
serveRuntimePlugin({ factory: async ({ emit }) => {
  const sessions = new Map();
  const get = id => { const value = sessions.get(id); if (!value) throw Object.assign(new Error("absent"), { code: "RUNTIME_SESSION_NOT_FOUND" }); return value; };
  return { homeIdentity: "fixture-home", capabilities: {
    "session.start": true, "session.resume": true, "session.read": true, "session.list": true,
    "turn.start": true, "turn.interrupt": true, "models.list": true, "commands.list": true, events: true },
    authenticationState: () => ({ authenticated: true }),
    sessionStart: input => { const session = { id: `fixture-session-${sessions.size + 1}`, source: input.source, cwd: input.cwd, archived: false, turns: [] };
      sessions.set(session.id, session); return { session }; },
    sessionResume: ({ sessionId }) => ({ session: get(sessionId) }),
    sessionRead: ({ sessionId }) => ({ session: get(sessionId) }),
    sessionList: () => ({ data: [...sessions.values()], nextCursor: null }), modelsList: () => ({ data: [], nextCursor: null }), commandsList: () => ({ commands: [] }),
    turnStart: input => {
      const session = get(input.sessionId), turn = { id: `fixture-turn-${session.turns.length + 1}`, status: "inProgress",
        items: [{ type: "userMessage", id: input.operationId, clientId: input.operationId, content: input.input || [{ type: "text", text: "fixture" }] }] };
      session.turns.push(turn);
      setTimeout(() => { turn.status = "completed"; turn.items.push({ type: "agentMessage", id: `${turn.id}-answer`, text: "Fixture complete", phase: "final_answer" });
        emit({ known: true, type: "text", sessionId: session.id, turnId: turn.id, itemId: `${turn.id}-answer`, text: "Fixture complete", phase: "final_answer" });
        emit({ known: true, type: "complete", sessionId: session.id, turnId: turn.id, status: "completed" }); }, 30);
      return { turn: { id: turn.id, status: turn.status } };
    }, turnInterrupt: () => ({}), stop: () => {},
  };
} });
