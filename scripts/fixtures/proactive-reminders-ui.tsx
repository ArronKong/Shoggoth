import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import ChatPage from '../../app/manage-ui/src/pages/ChatPage';
import { UiProvider } from '../../app/manage-ui/src/components/ui';
import ScrollbarProvider from '../../app/manage-ui/src/components/ScrollbarProvider';
import { NavigationGuardProvider } from '../../app/manage-ui/src/lib/navigation-guard';
import i18n from '../../app/manage-ui/src/i18n';
import '../../app/manage-ui/src/styles.css';
import '../../app/manage-ui/src/manage-skin.css';
const state = window as any, now = Date.now(), calls: any[] = [];
const key = 'agent:review:reminder-session', taskKey = 'agent:review:original-task-session';
const text = '这三条便签值得回顾：一个可以继续的小想法、一项待审批请求，以及已发芽多日但还没标记为结果的产出。\n\n'
  + '- [灵感种子](#/inspirations?id=note-0)\n- [待审批的原任务](#/chat?backend=shoggoth&session=' + encodeURIComponent(taskKey) + ')\n'
  + '- [已有产出，查看后可标记为结果](#/inspirations?id=note-2)';
class Socket {
  static OPEN = 1; readyState = 1; onopen: (() => void) | null = null; onmessage: ((event: any) => void) | null = null;
  constructor() { setTimeout(() => this.onopen?.(), 0); }
  send(value: string) {
    const request = JSON.parse(value); calls.push(request);
    const payload = request.method === 'sessions.list' ? { sessions: [
      { key, backendId: 'shoggoth', agentId: 'review', agentName: '审查 Agent', displayName: '提醒', source: 'proactive', proactiveTarget: true, updatedAt: now },
      { key: taskKey, backendId: 'shoggoth', agentId: 'review', agentName: '审查 Agent', displayName: '原任务', updatedAt: now - 1000 }], hasMore: false }
      : request.method === 'agents.list' ? { agents: [{ id: 'review', name: '审查 Agent', backendId: 'shoggoth' }] }
      : request.method === 'chat.history' ? { messages: [{ role: 'assistant', id: 'fixture-message', timestamp: now,
        content: [{ type: 'text', text: request.params?.sessionKey === taskKey ? 'ORIGINAL-TASK-RESTORED' : text }],
        ...(request.params?.sessionKey === taskKey ? {} : { shoggoth: { proactiveNotice: { id: 'notice-fixture', kind: 'inspiration' }, notificationCategory: 'proactive' } }) }] }
      : {};
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'res', id: request.id, ok: true, payload }) }), 1);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = Socket;
window.fetch = async url => {
  const pathname = String(url).split('?')[0]; let payload: any = {};
  if (pathname.startsWith('/__api/proactive')) throw Error('SparkNotes must not load a settings or note-reminder UI');
  if (pathname === '/__api/config') payload = { disabledBackends: [], locale: 'zh-CN', notifications: { chat: true, cron: true, task: true, proactive: true } };
  else if (pathname === '/__api/status') payload = [{ id: 'shoggoth', name: 'Shoggoth', enabled: true, state: 'started', capabilities: { chat: true } }];
  else if (pathname === '/__api/models') payload = { catalogRevision: 'fixture', models: [], profiles: {}, readyModels: [], canAddModel: false };
  else if (pathname === '/__api/providers') payload = { providers: [] };
  else if (pathname === '/__api/sessions') payload = { sessions: [] };
  else if (pathname === '/__api/session') payload = { messages: [] };
  else if (pathname.includes('runtime-models')) payload = { selection: { bindingId: 'fixture-binding', runtime: 'codex', model: null, canSwitch: false, candidates: [] }, capabilities: { attachments: {}, slash: false, steer: false }, models: [], runtimes: [] };
  else if (pathname.includes('/archive')) payload = { archive: { supported: true, segments: [] } };
  return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
};
localStorage.setItem('shoggoth.chat.sessions.v1', JSON.stringify([{ key, backendId: 'shoggoth', agentId: 'review', updatedAt: now }]));
localStorage.setItem('shoggoth.chat.lastActive.v1', key);
window.location.hash = '#/chat?backend=shoggoth&session=' + encodeURIComponent(key);
void i18n.changeLanguage('zh-CN');
window.addEventListener('error', event => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener('unhandledrejection', event => { state.fixtureError = String(event.reason); });
createRoot(document.getElementById('root')!).render(<UiProvider><HashRouter><NavigationGuardProvider><ScrollbarProvider /><ChatPage /></NavigationGuardProvider></HashRouter></UiProvider>);
state.proactiveFixture = { calls, i18n, taskKey };
