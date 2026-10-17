'use strict';
const { createRequire } = require('node:module');

// Mechanical plumbing shared by the ACP instrumentation modules: one way to
// resolve the native registration API, one way to undo a wrapper. Callers keep
// their own eligibility rules, state machines, instance symbols and error
// identities — this only removes the duplicated boilerplate.

function loadAcpApi(nativeMainPath, errorMessage = 'Native ACP registration API is unavailable') {
  if (typeof nativeMainPath !== 'string' || !nativeMainPath) throw new TypeError('nativeMainPath is required');
  const api = createRequire(nativeMainPath)('vscode')?.windsurfAcp;
  if (!api || typeof api.registerConnection !== 'function') throw new Error(errorMessage);
  return api;
}

// Undo a wrapper only while it is still installed: a method someone else
// replaced in the meantime is left untouched, and a method that was inherited
// (no own descriptor) is removed again rather than frozen as an own property.
function restoreMember(target, key, wrapper, descriptor) {
  if (target[key] !== wrapper) return;
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else delete target[key];
}

module.exports = { loadAcpApi, restoreMember };
