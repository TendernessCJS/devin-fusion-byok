'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, builtinModules } = require('node:module');

// Loads a CommonJS entry inside a single VM realm shared by the whole fixture.
// Stubs are matched by RESOLVED absolute path: a key like './config.cjs' is
// resolved against the entry's directory, so '../config.cjs' required from a
// sibling directory (src/activation/*.cjs) hits the same stub. Relative
// requires without a stub are loaded inside this same context — never through
// the host realm's require — sharing one module cache (one instance per file,
// or realm mismatches break instanceof and singleton guards).
//
// `globals` shadow the entry file's scope only by default — the historical
// behavior this loader reproduces: the sandboxed entry got injected fetch /
// immediate setTimeout while realRequire'd dependencies ran on real ones.
// Pass `shareGlobals(resolved)` to extend them to additional own modules
// (e.g. src/activation/*) whose timing is part of the fixture's behavior.
function createSandboxLoader({ filename, overrides = {}, globals = {}, shareGlobals = null }) {
  const entry = path.resolve(filename);
  const entryDir = path.dirname(entry);
  const realRequire = createRequire(filename);
  const stubs = new Map();
  const hits = new Set();
  for (const [key, value] of Object.entries(overrides))
    stubs.set(key.startsWith('.') ? path.resolve(entryDir, key) : key, value);
  const cache = new Map();
  const hostGlobals = {
    process, console, Buffer, URL, TextDecoder, TextEncoder,
    AbortController, AbortSignal, queueMicrotask, structuredClone, setImmediate,
    fetch: (...args) => fetch(...args),
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  const context = vm.createContext({ ...hostGlobals, ...globals });
  const names = Object.keys(globals);
  const load = resolved => {
    const cached = cache.get(resolved);
    if (cached) return cached.exports;
    const module = { exports: {} };
    cache.set(resolved, module);
    if (resolved.endsWith('.json')) {
      module.exports = JSON.parse(fs.readFileSync(resolved, 'utf8'));
      return module.exports;
    }
    const dirname = path.dirname(resolved);
    const localRequire = specifier => {
      if (specifier.startsWith('.')) {
        const target = path.resolve(dirname, specifier);
        if (stubs.has(target)) { hits.add(target); return stubs.get(target); }
        if (!fs.existsSync(target)) throw new Error(`No stub or file for '${specifier}' required from ${resolved}`);
        return load(target);
      }
      if (stubs.has(specifier)) { hits.add(specifier); return stubs.get(specifier); }
      if (specifier === 'vscode' || specifier.startsWith('node:') || builtinModules.includes(specifier))
        return realRequire(specifier);
      throw new Error(`Module '${specifier}' required from ${resolved} has no stub and is not a builtin`);
    };
    const shared = resolved === entry || (shareGlobals && shareGlobals(resolved));
    const source = fs.readFileSync(resolved, 'utf8');
    vm.runInContext(
      '(function (module, exports, require, __filename, __dirname' + (names.length ? ', ' + names.join(', ') : '') + ') {\n' + source + '\n})',
      context, { filename: resolved })
      .call(module, module, module.exports, localRequire, resolved, dirname,
        ...names.map(name => shared ? globals[name] : hostGlobals[name]));
    return module.exports;
  };
  const entryExports = load(entry);
  return {
    context,
    module: { exports: entryExports },
    // Every registered stub must be hit at least once per fixture run, or a
    // misspelled/extra key would pass silently while the real module loads.
    assertStubsUsed(label = 'sandbox fixture') {
      const unused = [...stubs.keys()].filter(key => !hits.has(key));
      if (unused.length) throw new Error(`${label}: stub keys never hit: ${unused.join(', ')}`);
    },
  };
}

module.exports = { createSandboxLoader };
