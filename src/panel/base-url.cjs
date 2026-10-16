'use strict';

// Shared by the extension host and the webview (injected via toString), so it
// must stay self-contained. Strips a pasted endpoint suffix, then adds /v1 only
// for a bare host: any path the user typed is authoritative. Appending /v1 to a
// typed path unconditionally (the old rule was "no version-looking segment")
// silently broke gateways that serve the API without one — `.../openai` became
// `.../openai/v1`, and no input from the panel could express the right URL.
function normalizeBaseUrlPath(pathname) {
  const path = String(pathname || '').replace(/\/(?:responses|chat\/completions|messages|models)\/?$/, '').replace(/\/+$/, '');
  return path || '/v1';
}

module.exports = { normalizeBaseUrlPath };
