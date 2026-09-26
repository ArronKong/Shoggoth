#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'inspiration-trajectory-'));
try {
  const output = path.join(scratch, 'timeline.cjs');
  require('esbuild').buildSync({ entryPoints: [path.join(root, 'app/manage-ui/src/lib/turnTimeline.ts')],
    outfile: output, bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent' });
  const { stepsFromParts } = require(output);
  const parts = [{ type: 'toolCall', toolCallId: 'a', toolName: 'write', toolArgs: { path: 'a.html' } },
    { type: 'toolCall', toolCallId: 'b', toolName: 'read', toolArgs: { path: 'b.txt' } },
    { type: 'toolResult', toolCallId: 'b', text: 'b failed', isError: true, durationS: 1.2 },
    { type: 'text', text: 'Still writing the file' }];
  const live = stepsFromParts(parts, { live: true, includeText: true });
  assert.equal(live[0].status, 'running'); assert.equal(live[0].output, undefined);
  assert.equal(live[1].status, 'error'); assert.equal(live[1].output, 'b failed'); assert.equal(live[1].durationS, 1.2);
  assert.equal(live[2].text, 'Still writing the file');
  const historical = stepsFromParts(parts);
  assert.equal(historical[0].status, 'aborted'); assert.equal(historical.length, 2);
  const completed = stepsFromParts([...parts, { type: 'toolResult', toolCallId: 'a', text: 'written' }], { live: true });
  assert.equal(completed[0].status, 'ok'); assert.equal(completed[0].output, 'written');
  const legacy = stepsFromParts([{ type: 'toolCall', toolName: 'read' }, { type: 'toolResult', text: 'legacy result' }]);
  assert.equal(legacy[0].status, 'ok'); assert.equal(legacy[0].output, 'legacy result');
  console.log('PASS: parallel tool results, running steps, completion, legacy FIFO, and default chat behavior');
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
