import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const ui = path.join(root, "app/manage-ui");
const require = createRequire(path.join(ui, "package.json"));
const esbuild = require("esbuild");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-skills-ui-"));
const output = path.join(temporary, "test.cjs");
const mocks = {
  "./SelfImprovementPanel": "export default function SelfImprovementPanel(props) { return <learned-detail-fixture {...props} />; }",
  "../api/client": `
    export class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
    export const getSkillUsage = async () => [];
    export const installSkill = async () => ({ canceled: true });
    export const listAgents = async () => [];
    export const listSkills = async () => [];
    export const selfImprovement = async (backend, agentId, action, input) => {
      globalThis.calls.push({ method: 'learning', backend, agentId, action, input });
      globalThis.skills = globalThis.skills.map(skill => skill.id === input.skillId && skill.agentId === agentId
        ? { ...skill, enabled: input.action === 'restore' } : skill);
    };
    export const listDisabledStandaloneMcp = async () => ({ revision: 1, totalDisabled: 0,
      items: [], nextCursor: 0, hasMore: false });
    export const rebindStandaloneMcp = async () => { throw new Error('not expected'); };
    export const activateStandaloneMcp = async () => { throw new Error('not expected'); };
    export const listSkillsPage = async (backend, agentId, options) => {
      globalThis.calls.push({ method: 'page', backend, agentId, options });
      if (globalThis.pageWait) await globalThis.pageWait;
      if (globalThis.failNextPage) { globalThis.failNextPage = false; throw new ApiError('unavailable', 503); }
      const revision = String(globalThis.skills.length) + '-' + globalThis.skills.map(skill => Number(skill.enabled)).join('');
      if (options.pageIndex > 0 && options.expectedRevision !== revision) throw new ApiError('changed', 409);
      const filtered = globalThis.skills.filter(skill => (!options.status || (options.status === 'on') === skill.enabled)
        && (!options.query || skill.name.includes(options.query) || skill.description.includes(options.query)));
      const pageSize = Math.min(options.limit, 73);
      return { supported: true, skills: filtered.slice(options.pageIndex * pageSize, (options.pageIndex + 1) * pageSize),
        registryRevision: 'a'.repeat(64), registryVersion: 2, profileRevision: 1,
        queryRevision: revision, pageIndex: options.pageIndex,
        pageCount: Math.max(1, Math.ceil(filtered.length / pageSize)), total: globalThis.skills.length,
        enabledCount: globalThis.skills.filter(skill => skill.enabled).length,
        usedCount: 0, usageSupported: true, matchCount: filtered.length };
    };
    export const previewSkill = async (backend, skill, agent) => {
      globalThis.calls.push({ method: 'preview', backend, skill, agent });
      return { content: 'Instructions ' + skill.version };
    };
    export const updateSkill = async (backend, name, patch, agent) => {
      globalThis.calls.push({ method: 'update', backend, name, patch, agent });
      globalThis.skills = globalThis.skills.map(s => s.id === patch.id && s.source === patch.source && s.version === patch.version
        && (s.source === 'user' || s.agentId === agent)
        ? { ...s, enabled: patch.enabled, registryVersion: s.registryVersion + 1 } : s);
      return globalThis.skills.find(s => s.id === patch.id && s.source === patch.source && s.version === patch.version);
    };
    export const uninstallSkill = async (backend, skill, agent) => {
      globalThis.calls.push({ method: 'uninstall', backend, skill, agent });
      globalThis.skills = globalThis.skills.filter(s => s.version !== skill.version);
    };
  `,
  "../lib/usePageCache": `
    import { useState } from 'react';
    export function usePageCache(key) {
      const [, force] = useState(0);
      return { data: key.startsWith('skills:agents:') ? [{ id: 'agent-a', name: 'Agent A' }]
        : key.startsWith('skills:usage:') ? [] : globalThis.skills,
        loading: false, error: null, refresh: async () => force(n => n + 1) };
    }
  `,
  "../lib/page-refresh": "export function useRegisterPageRefresh() {} export function useRegisterPageLoading() {}",
  "../lib/backends": `
    import { useState } from 'react';
    const catalog = [{ id: 'native-fixture', name: 'Fixture', surfaces: { agentHarness: true } },
      ...['openclaw', 'hermes'].map(id => ({ id, name: id, surfaces: { agentHarness: false } }))];
    export const useBackendCatalog = () => catalog;
    export const useBackendState = () => useState(globalThis.initialBackend || 'native-fixture');
  `,
  "../lib/useStickyState": "import { useState } from 'react'; export const useStickyState = (key, value) => useState(key === 'skills.status' ? 'off' : value);",
  "../components/Field": `
    export const Field = ({children}) => children;
    export const Option = () => null;
    export const Select = () => <select-fixture />;
    export const TextInput = () => null;
    export const TextArea = () => null;
    export const Switch = (props) => <switch-fixture {...props} />;
  `,
  "../components/ui": `
    const toast = { success() {}, info() {}, error(error) { throw new Error(error); } };
    const confirm = async input => { globalThis.confirmation = input; return true; };
    export const useToast = () => toast;
    export const useConfirm = () => confirm;
  `,
  "../lib/markdown": "export const toSanitizedMarkdownHtml = value => value;",
  "../components/ChatMarkdown": "export default function ChatMarkdown({text, className}) { return <div className={className} data-markdown={text} />; }",
  "../components/PageHead": "export const PageHead = ({actions}) => <header>{actions}</header>;",
  "../components/BackendTabs": "export default function BackendTabs(props) { return <backend-tabs-fixture {...props} />; }",
  "../components/Modal": `export default function Modal({ open, title, subtitle, children, onClose }) {
    return open ? <section role="dialog"><h2>{title}</h2>{subtitle}{children}<button aria-label="Close" onClick={onClose} /></section> : null;
  }`,
  "./SkillsPage.module.css": "export default { detailModal: 'skill-detail-modal', detail: 'skill-detail-content' };",
  "../components/FilterTabs": "export default function FilterTabs() { return <filter-tabs-fixture />; }",
  "../components/SearchCapsule": "export default function SearchCapsule(props) { return <search-fixture {...props} />; }",
  "react-i18next": `
    import en from ${JSON.stringify(path.join(ui, "src/i18n/locales/en.ts"))};
    const t = (key, vars = {}) => key.split('.').reduce((value, part) => value?.[part], en)
      ?.replace(/{{(\\w+)}}/g, (_, variable) => String(vars[variable] ?? '')) || key;
    export const useTranslation = () => ({ t });
  `,
};

try {
  await esbuild.build({
    stdin: { resolveDir: ui, sourcefile: "skills-test.tsx", loader: "tsx", contents: `
      import assert from 'node:assert/strict';
      import React from 'react';
      import TestRenderer, { act } from 'react-test-renderer';
      import SkillsPage from './src/pages/SkillsPage';
      import { skillIdentity } from './src/lib/skillIdentity';
      import { splitSkillDocument, markdownCodeBlock } from './src/lib/skillDocument';
      import { listSkillsPage, previewSkill, uninstallSkill } from './src/api/client';
      import en from './src/i18n/locales/en';
      import zh from './src/i18n/locales/zh-CN';
      async function main() {
        const document = splitSkillDocument("\\ufeff---\\r\\nname: lark-im\\r\\nversion: 1.0.0\\r\\n---\\r\\n\\r\\n## Shoggoth installation\\r\\n\\r\\nThis official Feishu / Lark skill belongs to the CLI connector (CLI 1.0.98).\\r\\nUse /private/fixture/bin/lark-cli\\r\\n\\r\\n~~~sh\\r\\n# not a document boundary\\r\\n~~~\\r\\n\\r\\n# im (v1)\\r\\n\\r\\n## Concepts\\r\\n\\r\\nAuthored instructions.");
        assert.equal(document.frontmatter, 'name: lark-im\\r\\nversion: 1.0.0');
        assert.match(document.installation, /# not a document boundary/);
        assert.equal(document.body, '# im (v1)\\n\\n## Concepts\\n\\nAuthored instructions.');
        assert.equal(splitSkillDocument('---\\nUnclosed metadata').body, '---\\nUnclosed metadata');
        assert.equal(splitSkillDocument('# Guide\\n\\n---\\nordinary body').body, '# Guide\\n\\n---\\nordinary body');
        assert.equal(splitSkillDocument('## Shoggoth installation\\n\\nCustom authored section').installation, '');
        assert.equal(markdownCodeBlock('a' + String.fromCharCode(96).repeat(4) + 'b', 'yaml').split('\\n')[0].length, 9);
        globalThis.calls = [];
        globalThis.skills = ['1.0.0', '1.0.1'].map(version => ({
          backendId: 'native-fixture', agentId: 'agent-a', id: 'review', name: 'review', version,
          source: 'user', description: 'Description ' + version, enabled: false,
          profileRevision: 1, registryVersion: 2,
        }));
        const [older, newer] = globalThis.skills;
        assert.notEqual(skillIdentity(older), skillIdentity(newer));
        assert.notEqual(skillIdentity(newer), skillIdentity({ ...newer, agentId: 'agent-b' }));
        assert.notEqual(skillIdentity(newer), skillIdentity({ ...newer, backendId: 'another' }));
        assert.notEqual(skillIdentity(newer), skillIdentity({ ...newer, source: 'builtin' }));
        let renderer;
        await act(async () => { renderer = TestRenderer.create(<SkillsPage />); });
        assert.equal(globalThis.calls.find(call => call.method === 'page').agentId, undefined,
          'the catalog must request all Agents');
        assert.equal(globalThis.calls.find(call => call.method === 'page').options.status, '',
          'the catalog must ignore saved status filters');
        assert.equal(renderer.root.findAllByType('filter-tabs-fixture').length, 0);
        assert.equal(renderer.root.findAllByType('search-fixture').length, 0);
        assert.equal(renderer.root.findAllByType('select-fixture').length, 0);
        assert.equal(renderer.root.findAllByType('learned-detail-fixture').length, 0,
          'the automatic learning card must not be mounted');
        assert.equal(renderer.root.findAllByType('button').some(node => node.children.includes(en.skills.install)), false);
        await act(async () => { renderer.root.findByProps({ 'aria-label': 'review v1.0.1 · user' }).props.onClick(); });
        const cards = () => renderer.root.findAllByType('article');
        assert.equal(cards().filter(node => node.props.className.includes('skill-card-selected')).length, 0);
        assert.equal(renderer.root.findAllByType('aside').length, 0, 'details must use the shared modal');
        const detail = () => renderer.root.findByProps({ role: 'dialog' });
        assert.match(detail().findByProps({ className: 'skill-detail-meta' }).children.join(''), /v1\.0\.1/);
        assert.equal(globalThis.calls.find(call => call.method === 'preview').skill.version, '1.0.1');
        let releasePage;
        globalThis.pageWait = new Promise(resolve => { releasePage = resolve; });
        await act(async () => { await detail().findByType('switch-fixture').props.onChange(true); });
        assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 1,
          'refreshing after a toggle must keep the detail modal open');
        await act(async () => { releasePage(); delete globalThis.pageWait; });
        const updated = globalThis.calls.find(call => call.method === 'update');
        assert.equal(updated.patch.id, 'review');
        assert.equal(updated.patch.version, '1.0.1');
        assert.equal(updated.patch.expectedRevision, 2);
        assert.equal(updated.agent, 'agent-a');
        assert.equal(globalThis.skills[0].enabled, false);
        assert.equal(globalThis.skills[1].enabled, true);
        await act(async () => { await detail().findAllByType('button').find(node => node.props.className === 'btn-danger').props.onClick(); });
        assert.match(globalThis.confirmation.message, /review v1.0.1/);
        assert.equal(globalThis.calls.find(call => call.method === 'uninstall').skill.version, '1.0.1');
        assert.equal(globalThis.calls.find(call => call.method === 'uninstall').skill.registryVersion, 4);
        assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);
        assert.deepEqual(globalThis.skills.map(skill => skill.version), ['1.0.0']);
        await act(async () => renderer.unmount());

        globalThis.window = Object.assign(new EventTarget(), {
          requestAnimationFrame(callback) { callback(); }, matchMedia() { return { matches: false }; },
        });
        globalThis.skills = ['agent-a', 'agent-b'].flatMap((agentId, index) => [
          { backendId: 'native-fixture', agentId, id: 'scoped-review', name: 'scoped-review',
            version: '1.0.0', source: 'builtin', description: 'Agent method', enabled: true,
            profileRevision: index + 3, usageCount: index + 1, usageAgents: { [agentId]: index + 1 } },
          { backendId: 'native-fixture', agentId, id: 'learned-' + agentId, name: 'learned-review',
            version: '1.0.0', source: 'learned', description: 'Learned method', enabled: true,
            contentHash: String(index + 1).repeat(64), learnedRevision: index + 5, usageCount: index + 7 },
        ]);
        await act(async () => { renderer = TestRenderer.create(<SkillsPage />); });
        assert.equal(cards().length, 4, 'skills from both Agents must appear together');
        await act(async () => cards()[0].findByProps({ className: 'skill-card-open' }).props.onClick());
        assert.equal(detail().findByProps({ className: 'skill-sec-aside' }).children.join(''),
          en.skills.usageTotal.replace('{{count}}', '1'));
        await act(async () => cards()[2].findByProps({ className: 'skill-card-open' }).props.onClick());
        assert.equal(globalThis.calls.findLast(call => call.method === 'preview').agent, 'agent-b');
        assert.equal(detail().findByProps({ className: 'skill-sec-aside' }).children.join(''),
          en.skills.usageTotal.replace('{{count}}', '2'), 'same-name usage must stay scoped to the selected Agent');
        await act(async () => detail().findByType('switch-fixture').props.onChange(false));
        const scopedUpdate = globalThis.calls.findLast(call => call.method === 'update');
        assert.equal(scopedUpdate.agent, 'agent-b');
        assert.equal(scopedUpdate.patch.expectedRevision, 4);
        assert.equal(globalThis.skills[0].enabled, true, 'another Agent must keep its own enabled state');
        await act(async () => cards()[3].findByProps({ className: 'skill-card-open' }).props.onClick());
        const learnedDetail = renderer.root.findByType('learned-detail-fixture');
        assert.equal(learnedDetail.props.detailOnly, true);
        assert.equal(learnedDetail.props.agentId, 'agent-b');
        assert.equal(learnedDetail.props.skillSelection.id, 'learned-agent-b');
        await act(async () => cards()[3].findByType('switch-fixture').props.onChange(false));
        const learnedChange = globalThis.calls.findLast(call => call.method === 'learning');
        assert.equal(learnedChange.agentId, 'agent-b');
        assert.equal(learnedChange.input.expectedRevision, 6);
        assert.equal(globalThis.skills[1].enabled, true);
        assert.equal(globalThis.skills[3].enabled, false);
        const beforeChange = globalThis.calls.filter(call => call.method === 'page').length;
        await act(async () => window.dispatchEvent(new CustomEvent('shoggoth:skills-changed', {
          detail: { backendId: 'native-fixture', agentId: 'agent-a' },
        })));
        assert.equal(globalThis.calls.filter(call => call.method === 'page').length, beforeChange + 1,
          'a change from any Agent must refresh the aggregate');
        await act(async () => renderer.unmount());
        delete globalThis.window;

        const authoring = { backendId: 'native-fixture', agentId: 'agent-a', agentName: 'Agent A',
          id: 'shoggoth-skill-authoring', name: 'shoggoth-skill-authoring', version: '1.0.0',
          source: 'builtin', description: 'Author skills', enabled: true, globalSettingRevision: 7,
          registryVersion: 2, profileRevision: 3 };
        globalThis.skills = [authoring];
        await act(async () => { renderer = TestRenderer.create(<SkillsPage />); });
        assert.equal(cards().length, 1);
        assert.equal(cards()[0].findByType('switch-fixture').props.checked, true);
        await act(async () => cards()[0].findByProps({ className: 'skill-card-open' }).props.onClick());
        await act(async () => detail().findByType('switch-fixture').props.onChange(false));
        assert.equal(globalThis.calls.findLast(call => call.method === 'update').patch.expectedRevision, 7);
        assert.equal(cards()[0].findByType('switch-fixture').props.checked, false);
        const scope = detail().findByProps({ className: 'skill-detail-meta' }).children.join('');
        assert.ok(scope.includes(en.skills.globalScope));
        assert.ok(!scope.includes(authoring.agentName), 'the global switch does not belong to its routing Agent');
        assert.equal(skillIdentity(authoring), skillIdentity({ ...authoring, agentId: 'agent-b', enabled: false }));
        await act(async () => renderer.unmount());

        globalThis.skills = Array.from({ length: 5000 }, (_, index) => ({
          backendId: 'native-fixture', agentId: 'agent-a', id: 'scale-' + String(index).padStart(4, '0'),
          name: 'scale-' + String(index).padStart(4, '0'), version: '1.0.0', source: 'user',
          description: 'Skill at ' + index, enabled: true, profileRevision: 1, registryVersion: 2,
        }));
        const observers = [];
        globalThis.IntersectionObserver = class {
          constructor(callback) { this.callback = callback; observers.push(this); }
          observe() { this.active = true; }
          disconnect() { this.active = false; }
        };
        const loadNext = () => {
          const observer = observers.findLast(value => value.active);
          assert.ok(observer, 'the visible loading sentinel must be observed');
          observer.callback([{ isIntersecting: true }]);
          observer.callback([{ isIntersecting: true }]);
        };
        globalThis.pageFocus = [];
        const createNodeMock = element => {
          if (element.props.className === 'skill-load-more') return {};
          if (!element.props.className?.split(' ').includes('skill-main-content')) return null;
          return { scrollTo() { globalThis.pageFocus.push('scroll'); } };
        };
        await act(async () => { renderer = TestRenderer.create(<SkillsPage />, { createNodeMock }); });
        assert.equal(cards().length, 73, 'initial loading must respect server byte boundaries');
        assert.equal(renderer.root.findAllByType('nav').length, 0, 'there are no pagination controls');
        await act(async () => loadNext());
        assert.equal(cards().length, 146, 'scrolling appends the next batch');
        assert.equal(cards()[0].props.title, 'scale-0000', 'earlier cards remain in place');
        assert.equal(globalThis.calls.findLast(call => call.method === 'page').options.pageIndex, 1,
          'repeated observer callbacks must not skip a batch');
        assert.deepEqual(globalThis.pageFocus, [], 'loading more must preserve scroll and keyboard focus');
        globalThis.failNextPage = true;
        await act(async () => loadNext());
        assert.equal(cards().length, 146, 'a failed next batch must retain already loaded cards');
        await act(async () => renderer.root.findAllByType('button').find(node => node.children.includes(en.skills.retryLoad)).props.onClick());
        assert.equal(cards().length, 219, 'retry resumes the failed batch without duplication');
        globalThis.skills[0] = { ...globalThis.skills[0], enabled: false };
        await act(async () => loadNext());
        assert.equal(cards().length, 73, 'stale catalog revisions must restart from a consistent snapshot');
        assert.equal(globalThis.calls.findLast(call => call.method === 'page').options.pageIndex, 0);
        assert.equal(cards()[0].props.title, 'scale-0000');
        assert.equal(renderer.root.findAllByType('search-fixture').length, 0);
        await act(async () => renderer.unmount());

        for (const backend of ['openclaw', 'hermes']) {
          globalThis.initialBackend = backend;
          globalThis.skills = Array.from({ length: 250 }, (_, index) => ({
            backendId: backend, name: 'external-' + String(index).padStart(3, '0'),
            description: 'External Skill ' + index, enabled: true,
          }));
          await act(async () => { renderer = TestRenderer.create(<SkillsPage />, { createNodeMock }); });
          assert.equal(cards().length, 100, backend + ' starts with one batch');
          await act(async () => loadNext());
          assert.equal(cards().length, 200, backend + ' appends on scroll');
          await act(async () => loadNext());
          assert.equal(cards().length, 250, backend + ' reaches the final batch');
          assert.equal(cards()[0].props.title, 'external-000');
          assert.equal(cards().at(-1).props.title, 'external-249');
          assert.equal(renderer.root.findAllByType('nav').length, 0);
          assert.equal(renderer.root.findAllByProps({ className: 'skill-load-more' }).length, 0,
            'the observer stops when all Skills are visible');
          await act(async () => renderer.root.findByType('backend-tabs-fixture').props.onChange('native-fixture'));
          await act(async () => renderer.root.findByType('backend-tabs-fixture').props.onChange(backend));
          assert.equal(cards().length, 100, 'changing backend resets the visible batch');
          await act(async () => renderer.unmount());
        }
        delete globalThis.initialBackend;
        delete globalThis.IntersectionObserver;

        const requests = [];
        globalThis.fetch = async (url, init) => { requests.push({ url, init }); return { ok: true, text: async () => JSON.stringify({ preview: { content: 'test' } }) }; };
        await previewSkill('native-fixture', newer, 'agent-a');
        await uninstallSkill('native-fixture', newer, 'agent-a');
        for (const request of requests) {
          const params = new URL(request.url, 'http://localhost').searchParams;
          assert.equal(params.get('id'), 'review');
          assert.equal(params.get('source'), 'user');
          assert.equal(params.get('version'), '1.0.1');
          assert.equal(params.get('agentId'), 'agent-a');
        }
        globalThis.fetch = async url => { requests.push({ url }); return { ok: true, text: async () => JSON.stringify({ page: { supported: true } }) }; };
        await listSkillsPage('native-fixture', undefined, { query: '', status: '', pageIndex: 0, limit: 100, expectedRevision: null });
        assert.equal(new URL(requests.at(-1).url, 'http://localhost').searchParams.has('agentId'), false);
        for (const dictionary of [en, zh]) {
          for (const key of ['install', 'installedToast', 'uninstall', 'uninstallTitle', 'uninstallMessage',
            'uninstalledToast', 'instructionsSection', 'dependenciesSection', 'requiredTools',
            'noRequiredTools', 'requiredRuntime', 'noRequiredRuntime']) {
            assert.equal(typeof dictionary.skills[key], 'string', 'missing skills.' + key);
            assert.equal(dictionary.models[key], undefined, 'Skill text must live in its own namespace');
          }
        }
        console.log('PASS Skills all-Agent catalog, hidden controls, scoped details/toggles/usage, all three backends scroll loading/retry, transport identity and bilingual labels');
      }
      export default main();
    ` },
    outfile: output, bundle: true, platform: "node", format: "cjs", jsx: "automatic", logLevel: "silent",
    plugins: [{ name: "skills-test-boundaries", setup(build) {
      build.onResolve({ filter: /.*/ }, args => {
        // Keep React's Node async-act scheduler; bundling selects a browser
        // MessageChannel fallback whose ports keep this test process alive.
        if (/^(react|react-test-renderer)(\/|$)/.test(args.path)) {
          return { path: require.resolve(args.path), external: true };
        }
        if (Object.hasOwn(mocks, args.path) && (args.importer.endsWith("SkillsPage.tsx")
          || args.importer.endsWith("StandaloneMcpRepair.tsx") || args.path === "react-i18next")) {
          return { path: args.path, namespace: "skills-mock" };
        }
      });
      build.onLoad({ filter: /.*/, namespace: "skills-mock" }, args => ({ contents: mocks[args.path], loader: "tsx", resolveDir: ui }));
    } }],
  });
  await require(output).default;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
