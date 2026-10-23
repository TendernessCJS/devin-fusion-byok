'use strict';
const fs = require('node:fs');
const path = require('node:path');
const REQUIRE_LITERAL = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g;
const REQUIRE_ANY = /\brequire\(/g;

function createSourceGraph({ readFile = file => fs.readFileSync(file, 'utf8'), exists = file => fs.existsSync(file) } = {}) {
  const depsOf = (file, { tolerateDynamic = false } = {}) => {
    const text = readFile(file);
    const literals = [...text.matchAll(REQUIRE_LITERAL)].map(match => match[2]);
    const calls = [...text.matchAll(REQUIRE_ANY)].length;
    if (calls !== literals.length) {
      if (!tolerateDynamic) {
        const error = new Error(`source graph requires static require specifiers; found a dynamic require in ${file}`);
        error.code = 'source_graph_dynamic_require';
        throw error;
      }
      return { deps: literals.filter(specifier => specifier.startsWith('.'))
        .map(specifier => path.resolve(path.dirname(file), specifier)).filter(exists), dynamic: true };
    }
    const deps = [];
    for (const specifier of literals) {
      if (!specifier.startsWith('.')) {
        if (specifier === 'vscode') deps.push('vscode');
        continue;
      }
      const resolved = path.resolve(path.dirname(file), specifier);
      if (exists(resolved)) deps.push(resolved);
    }
    return { deps, dynamic: false };
  };
  const walk = (entries, options) => {
    const graph = new Map();
    const dynamic = [];
    const queue = entries.map(file => path.resolve(file));
    while (queue.length) {
      const file = queue.shift();
      if (graph.has(file)) continue;
      const { deps, dynamic: isDynamic } = depsOf(file, options);
      if (isDynamic) dynamic.push(file);
      graph.set(file, deps);
      for (const dep of deps) if (dep !== 'vscode' && !graph.has(dep)) queue.push(dep);
    }
    return { graph, dynamic };
  };
  const closure = entry => new Set(walk([entry]).graph.keys());
  const findCycle = entries => {
    const { graph, dynamic } = walk(entries, { tolerateDynamic: true });
    const state = new Map();
    const stack = [];
    const visit = file => {
      state.set(file, 1); stack.push(file);
      for (const dep of graph.get(file) || []) {
        if (dep === 'vscode') continue;
        const mark = state.get(dep) || 0;
        if (mark === 1) return stack.slice(stack.indexOf(dep)).concat(dep);
        if (mark === 0) { const found = visit(dep); if (found) return found; }
      }
      stack.pop(); state.set(file, 2);
      return null;
    };
    let cycle = null;
    for (const file of graph.keys()) {
      if ((state.get(file) || 0) === 0) { cycle = visit(file); if (cycle) break; }
    }
    return { cycle, dynamic };
  };
  return { depsOf, walk, closure, findCycle };
}
module.exports = { createSourceGraph };
