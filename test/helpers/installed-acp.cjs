'use strict';
// Extracts the real isTurnCompletingPromptResponse predicate from the
// installed Devin ACP bundle and evaluates only the extracted function
// sources — the bundle's bootstrap/imports/registrations never execute.
// Resolution is anchor-driven, not minified-name-driven:
//   export binding `isTurnCompletingPromptResponse:()=>NAME` (unique)
//   -> `function NAME(args){body}` declaration (unique, straight-line body)
//   -> the predicate dependency called first inside that body (unique decl)
// Any ambiguity, missing anchor or a body shape this extractor cannot read is
// a loud "installed Devin layout changed" failure — never a silent skip.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DEFAULT_ROOT = '/Applications/Devin.app/Contents/Resources/app';
const BUNDLE = 'extensions/windsurf/dist/extension.js';

function layoutError(message) {
  return new Error('installed Devin layout changed: ' + message);
}

function uniqueMatches(source, regex, what) {
  const hits = [...source.matchAll(regex)];
  if (hits.length !== 1) throw layoutError(`${what} expected exactly 1 occurrence, found ${hits.length}`);
  return hits[0];
}

// Reads `function NAME(args){body}` where body is straight-line (no nested
// braces); refuses anything richer instead of guessing.
function functionSource(source, name, what) {
  const decl = uniqueMatches(source, new RegExp('function\\s+' + name.replace(/\$/g, '\\$') + '\\s*\\(', 'g'), what + ' declaration');
  const body = source.slice(decl.index).match(/^function\s+[\w$]+\s*\(([^)]*)\)\s*\{([^{}]*)\}/);
  if (!body) throw layoutError(`${what} has a body shape the extractor cannot read`);
  return { args: body[1], body: body[2], source: body[0] };
}

function loadTurnCompletingPromptResponse(root) {
  root = root || process.env.DFBYOK_TEST_APP_ROOT || DEFAULT_ROOT;
  let stat;
  try { stat = fs.statSync(root); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw layoutError(`cannot stat ${root}: ${error.code}`);
  }
  if (!stat.isDirectory()) throw layoutError(`${root} is not a directory`);
  const bundlePath = path.join(root, BUNDLE);
  let source;
  try { source = fs.readFileSync(bundlePath, 'utf8'); } catch (error) {
    throw layoutError(`cannot read ${BUNDLE}: ${error.code}`);
  }

  const binding = uniqueMatches(source, /isTurnCompletingPromptResponse\s*:\s*\(\)\s*=>\s*([\w$]+)/g,
    'isTurnCompletingPromptResponse export binding');
  const target = functionSource(source, binding[1], 'target predicate');
  const depCall = target.body.match(/return\s*[^;]*?([\w$]+)\s*\(/);
  if (!depCall) throw layoutError('target predicate body has no direct predicate call to resolve');
  const dep = functionSource(source, depCall[1], 'dependency predicate');

  const sandbox = {};
  vm.createContext(sandbox);
  const options = { timeout: 1000 };
  sandbox[depCall[1]] = vm.runInNewContext(`(${dep.source});`, sandbox, options);
  return vm.runInNewContext(`(${target.source});`, sandbox, options);
}

module.exports = { loadTurnCompletingPromptResponse };
