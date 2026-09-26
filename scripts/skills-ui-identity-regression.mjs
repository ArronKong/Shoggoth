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
  "../api/client": `
    export const getSkillUsage = async () => [];
    export const installSkill = async () => ({ canceled: true });
    export const listAgents = async () => [];
    export const listSkills = async () => [];
    export const previewSkill = async (backend, skill, agent) => {
      globalThis.calls.push({ method: 'preview', backend, skill, agent });
      return { content: 'Instructions ' + skill.version };
    };
    export const updateSkill = async (backend, name, patch, agent) => {
      globalThis.calls.push({ method: 'update', backend, name, patch, agent });
      globalThis.skills = globalThis.skills.map(s => s.id === patch.id && s.source === patch.source && s.version === patch.version
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
        : key === 'skills:usage' ? [] : globalThis.skills,
        loading: false, error: null, refresh: async () => force(n => n + 1) };
    }
  `,
  "../lib/page-refresh": "export function useRegisterPageRefresh() {} export function useRegisterPageLoading() {}",
  "../lib/backends": `
    import { useState } from 'react';
    const catalog = [{ id: 'native-fixture', name: 'Fixture', surfaces: { agentHarness: true } }];
    export const useBackendCatalog = () => catalog;
    export const useBackendState = () => useState('native-fixture');
  `,
  "../lib/useStickyState": "import { useState } from 'react'; export const useStickyState = (key, value) => useState(value);",
  "../components/Field": `
    export const Field = ({children}) => children;
    export const Option = () => null;
    export const Select = () => null;
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
  "../components/PageHead": "export const PageHead = () => null;",
  "../components/BackendTabs": "export default function BackendTabs() { return null; }",
  "../components/FilterTabs": "export default function FilterTabs() { return null; }",
  "../components/SearchCapsule": "export default function SearchCapsule() { return null; }",
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
      import { previewSkill, uninstallSkill } from './src/api/client';
      import en from './src/i18n/locales/en';
      import zh from './src/i18n/locales/zh-CN';
      async function main() {
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
        await act(async () => { renderer.root.findByProps({ 'aria-label': 'review v1.0.1 · user' }).props.onClick(); });
        const cards = () => renderer.root.findAllByType('article');
        assert.equal(cards().filter(node => node.props.className.includes('skill-card-selected')).length, 1);
        assert.equal(cards()[1].props.className.includes('skill-card-selected'), true);
        const detail = () => renderer.root.findByType('aside');
        assert.match(detail().findByProps({ className: 'skill-detail-meta' }).children.join(''), /v1\.0\.1/);
        assert.equal(globalThis.calls.find(call => call.method === 'preview').skill.version, '1.0.1');
        await act(async () => { await detail().findByType('switch-fixture').props.onChange(true); });
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
        assert.equal(renderer.root.findAllByType('aside').length, 0);
        assert.deepEqual(globalThis.skills.map(skill => skill.version), ['1.0.0']);
        await act(async () => renderer.unmount());

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
        for (const dictionary of [en, zh]) {
          for (const key of ['install', 'installedToast', 'uninstall', 'uninstallTitle', 'uninstallMessage',
            'uninstalledToast', 'instructionsSection', 'dependenciesSection', 'requiredTools',
            'noRequiredTools', 'requiredRuntime', 'noRequiredRuntime']) {
            assert.equal(typeof dictionary.skills[key], 'string', 'missing skills.' + key);
            assert.equal(dictionary.models[key], undefined, 'Skill text must live in its own namespace');
          }
        }
        console.log('PASS Skills React selection, preview, enable, uninstall, transport identity and bilingual labels');
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
        if (Object.hasOwn(mocks, args.path) && (args.importer.endsWith("SkillsPage.tsx") || args.path === "react-i18next")) {
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
