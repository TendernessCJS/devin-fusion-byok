'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RULE_DIR = path.join(ROOT, '.devin', 'rules');
const INJECTION_LIMIT = 16384;

const ruleVolumes = () => fs.readdirSync(RULE_DIR).filter(name => name.endsWith('.md'))
  .map(name => path.join(RULE_DIR, name)).sort();

test('every injected rule volume stays under the 16,384-byte injection limit', () => {
  const over = [...ruleVolumes(), path.join(ROOT, 'AGENTS.md')]
    .map(file => ({ name: path.relative(ROOT, file), size: fs.statSync(file).size }))
    .filter(entry => entry.size >= INJECTION_LIMIT);
  assert.deepEqual(over.map(entry => `${entry.name} ${entry.size}`), [],
    'content past 16,384 bytes is dropped without warning — move the evidence half into a <topic>-forensics.md volume first');
});

test('AGENTS.md indexes every rule volume', () => {
  const index = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  const unindexed = ruleVolumes().map(file => path.basename(file))
    .filter(name => !index.includes(`.devin/rules/${name}`));
  assert.deepEqual(unindexed, [], 'a volume missing from the index cannot be read at the moment it is needed');
});

// A volume without frontmatter registers as `manual`: `devin rules list` shows it,
// but the model can never decide to load it, so every "何时必读" claim in AGENTS.md
// becomes unfalsifiable. Measured 2026-11-07: three volumes were in this state.
test('every rule volume declares a trigger and a description', () => {
  const offenders = [];
  for (const file of ruleVolumes()) {
    const head = fs.readFileSync(file, 'utf8').slice(0, 600);
    const frontmatter = head.match(/^---\n([\s\S]*?)\n---\n/);
    if (!frontmatter) { offenders.push(path.basename(file) + ' (no frontmatter)'); continue; }
    const keys = [...frontmatter[1].matchAll(/^([a-z_]+):/gm)].map(match => match[1]);
    const missing = ['trigger', 'description'].filter(key => !keys.includes(key));
    if (missing.length) offenders.push(path.basename(file) + ' (missing ' + missing.join(', ') + ')');
  }
  assert.deepEqual(offenders, [],
    'without frontmatter the loader registers the volume as manual, so the agent can never load it on its own');
});
