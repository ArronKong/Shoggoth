#!/usr/bin/env node
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const repo = path.resolve(__dirname, '..');
  const { buildInventory, renderMarkdown, scanFrozenPackage } = await import('./plugin-bundled-skill-dependency-inventory.mjs');
  const inventory = buildInventory();
  const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'resources/bundled-plugins/catalog.json'), 'utf8'));
  const declared = new Set(catalog.packages.flatMap(pkg => (pkg.details?.skills ?? []).map(skill => `${pkg.id}/${skill.name}`)));
  assert.equal(catalog.packages.length, 62);
  assert.equal(declared.size, 502);
  assert.equal(inventory.totals.skills, 502);
  assert.equal(inventory.totals.sourceFiles, 5378);
  assert.deepEqual(new Set(inventory.skills.map(skill => skill.id)), declared);
  assert.equal(inventory.skills.every(skill => skill.businessAvailability === 'not_assessed'), true);
  assert.ok(inventory.skills.find(skill => skill.id === 'figma/figma-design-to-code').namedToolCandidates.includes('get_design_context'));
  assert.equal(inventory.skills.find(skill => skill.id === 'stripe/stripe-docs').allowedTools, 'Bash(stripe docs *)');
  const unresolved = inventory.skills.filter(skill => skill.localLinks.some(link => link.status === 'missing'));
  assert.deepEqual(unresolved.map(skill => skill.id), ['mixpanel-headless/setup']);
  assert.deepEqual(unresolved[0].localLinks.filter(link => link.status === 'missing').map(link => link.target), [
    '../mixpanelyst/references/analytical-frameworks.md',
    '../mixpanelyst/references/python-api.md',
  ]);
  assert.equal(inventory.skills.find(skill => skill.id === 'shopify/shopify-hydrogen')
    .localLinks.some(link => link.status === 'missing'), false);
  assert.deepEqual(inventory.skills.find(skill => skill.id === 'shopify/shopify-hydrogen')
    .localLinks.filter(link => link.status === 'site_root_relative_inferred').map(link => link.target), [
      'docs/api/hydrogen/latest/customer/createcustomeraccount',
      'docs/api/hydrogen/latest/utilities/createcustomeraccountclient',
      'docs/api/hydrogen/latest/utilities/createstorefrontclient',
      'docs/api/hydrogen/utilities/createstorefrontclient',
    ]);
  assert.equal(inventory.skills.find(skill => skill.id === 'superpowers/writing-skills')
    .localLinks.some(link => link.status === 'missing'), false);
  const suppliedRoot = process.env.SHOGGOTH_PLUGIN_SOURCE_ROOT;
  if (suppliedRoot) {
    for (const id of ['mixpanel-headless', 'shopify', 'superpowers']) {
      assert.deepEqual(scanFrozenPackage(path.join(repo, 'resources/bundled-plugins/packages', id)),
        scanFrozenPackage(path.join(suppliedRoot, id)),
        `${id} bundled package must match the supplied original byte for byte`);
    }
    assert.equal(fs.existsSync(path.join(suppliedRoot, 'mixpanel-headless', 'skills',
      'mixpanelyst', 'references', 'analytical-frameworks.md')), false);
    assert.equal(fs.existsSync(path.join(suppliedRoot, 'mixpanel-headless', 'skills',
      'mixpanelyst', 'references', 'python-api.md')), false);
  }
  for (const skill of inventory.skills) {
    const bytes = fs.readFileSync(path.join(repo, skill.sourcePath));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), skill.sha256);
    assert.equal(skill.bytes, bytes.length);
    assert.ok(skill.supportFiles.every(file => !path.isAbsolute(file) && !file.includes('..')));
  }
  assert.equal(inventory.totals.withSkippedLargeText, 0);
  assert.ok(inventory.totals.supportFiles > 0);
  const json = `${JSON.stringify(inventory, null, 2)}\n`;
  assert.equal(fs.readFileSync(path.join(repo, 'docs/architecture/bundled-skill-dependency-inventory-2026-09-27.json'), 'utf8'), json);
  assert.equal(fs.readFileSync(path.join(repo, 'docs/architecture/bundled-skill-dependency-inventory-2026-09-27.md'), 'utf8'), renderMarkdown(inventory));

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shoggoth-skill-inventory-'));
  try {
    const packagesRoot = path.join(temp, 'packages');
    const skillDir = path.join(packagesRoot, 'demo', 'skills', 'one');
    const secondSkillDir = path.join(packagesRoot, 'demo', 'skills', 'two');
    fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
    fs.mkdirSync(secondSkillDir, { recursive: true });
    const originalMain = [
      '---', 'name: one', 'allowed-tools: mcp__demo__invoke', '---',
      '[rules](references/rules.md) [missing](../missing.md) [site](/docs/example)',
      '[remote docs](/docs/api/hydrogen/utilities/example) [inferred](docs/api/hydrogen/latest/example)',
      '````markdown', '[example](example.md)', '```python', '[nested example](nested.md)',
      '```', '````',
      '```typescript', '/** [remote docs example](docs/api/hydrogen/latest/fenced-example) */', '```',
      'Call `functions.exec` and `python3` when available. Use $CODEX_HOME.', '',
    ].join('\n');
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), originalMain);
    fs.writeFileSync(path.join(secondSkillDir, 'SKILL.md'), '---\nname: two\n---\nUse $CODEX_HOME.\n');
    fs.writeFileSync(path.join(skillDir, 'references', 'rules.md'), '# Rules\n');
    fs.writeFileSync(path.join(skillDir, 'scripts', 'run.py'), 'print(1)\n');
    const catalogPath = path.join(temp, 'catalog.json');
    const frozenPath = path.join(temp, 'frozen.json');
    const writeCatalog = () => {
      const fingerprint = scanFrozenPackage(path.join(packagesRoot, 'demo'));
      const batchDigest = crypto.createHash('sha256').update(JSON.stringify([{ directory: 'demo', digest: fingerprint.sourceDigest }])).digest('hex');
      fs.writeFileSync(catalogPath, JSON.stringify({ batchDigest, packages: [{
        id: 'demo', sourceDigest: fingerprint.sourceDigest, fileCount: fingerprint.fileCount, bytes: fingerprint.bytes,
        components: { skills: 2, mcp: 0 }, details: { skills: [{ name: 'one' }, { name: 'two' }], apps: ['demo-app'] },
      }] }));
      fs.writeFileSync(frozenPath, JSON.stringify({ batchDigest, summary: { packages: 1, skills: 2, filesWithoutDsStore: fingerprint.fileCount }, packages: [{
        directory: 'demo', sourceDigest: fingerprint.sourceDigest, files: fingerprint.fileCount, bytes: fingerprint.bytes,
        skills: [{ directory: 'one' }, { directory: 'two' }],
      }] }));
    };
    writeCatalog();
    const options = { catalogPath, frozenPath, packagesRoot, sourceRoot: temp, expectedSkills: 2, expectedPackages: 1 };
    const fixture = buildInventory(options);
    assert.equal(fixture.skills[0].scriptFiles.length, 1);
    assert.equal(fixture.skills[0].referenceFiles.length, 1);
    assert.equal(fixture.skills[0].localLinks.find(link => link.target === 'references/rules.md').status, 'present');
    assert.equal(fixture.skills[0].localLinks.find(link => link.target === '../missing.md').status, 'missing');
    assert.equal(fixture.skills[0].localLinks.find(link => link.target === '/docs/example').status, 'site_root_relative');
    assert.equal(fixture.skills[0].localLinks.find(link => link.target === 'docs/api/hydrogen/latest/example')
      .status, 'site_root_relative_inferred');
    assert.equal(fixture.skills[0].localLinks.some(link => [
      'example.md', 'nested.md', 'docs/api/hydrogen/latest/fenced-example',
    ].includes(link.target)), false, 'fenced examples are not installed local file dependencies');
    assert.deepEqual(fixture.skills[0].explicitTools, ['functions.exec', 'mcp__demo__invoke']);
    assert.deepEqual(fixture.skills[0].packageApps, ['demo-app']);
    assert.equal(fixture.skills.every(skill => skill.hostMarkers.includes('CODEX_HOME')), true);
    const originalCatalog = fs.readFileSync(catalogPath, 'utf8');
    const changedCatalog = JSON.parse(originalCatalog);
    changedCatalog.packages[0].sourceDigest = '0'.repeat(64);
    fs.writeFileSync(catalogPath, JSON.stringify(changedCatalog));
    assert.throws(() => buildInventory(options), /independent frozen inventory/);
    fs.writeFileSync(catalogPath, originalCatalog);
    const rules = path.join(skillDir, 'references', 'rules.md');
    fs.writeFileSync(rules, '# Changed\n');
    assert.throws(() => buildInventory(options), /Frozen source changed/);
    fs.writeFileSync(rules, '# Rules\n');
    const script = path.join(skillDir, 'scripts', 'run.py');
    const mode = fs.statSync(script).mode & 0o777;
    fs.chmodSync(script, mode | 0o111);
    assert.throws(() => buildInventory(options), /Frozen source changed/);
    fs.chmodSync(script, mode);
    const added = path.join(packagesRoot, 'demo', 'added.txt');
    fs.writeFileSync(added, 'extra\n');
    assert.throws(() => buildInventory(options), /Frozen source changed/);
    fs.unlinkSync(added);
    fs.unlinkSync(path.join(skillDir, 'SKILL.md'));
    writeCatalog();
    assert.throws(() => buildInventory(options), /Top-level Skill mismatch/);
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), originalMain);
    const extra = path.join(packagesRoot, 'demo', 'skills', 'extra');
    fs.mkdirSync(extra);
    fs.writeFileSync(path.join(extra, 'SKILL.md'), '# extra\n');
    writeCatalog();
    assert.throws(() => buildInventory(options), /Top-level Skill mismatch/);
    fs.mkdirSync(path.join(packagesRoot, 'unexpected'));
    assert.throws(() => buildInventory(options), /Frozen package directory list differs/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  process.stdout.write('Bundled Skill static dependency inventory: 502/502, fixture boundaries, generated outputs OK\n');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
