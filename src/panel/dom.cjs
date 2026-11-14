'use strict';
const { format } = require('../i18n/index.cjs');
function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
// Host-side markup is a template string, so translated copy is escaped before
// it is spliced in. Placeholders are filled after escaping: a param may carry
// markup the caller built (a <code> chip), the template itself never can.
function markupText(t) {
  return (key, params) => format(escapeAttribute(t(key)), params);
}
// Browser-side helpers shared by every webview. Standalone documents emit this
// once inside their own script; the main panel emits it once at the top level
// of its <script> — panelClient is serialized via toString() and picks these
// up from the enclosing scope, so it must not declare them again.
function domHelpersSource(indent = '') {
  const source = `const byId = (id, prefix = '') => document.getElementById(prefix + id);
const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
const FORBIDDEN_ATTRS = new Set(['href', 'src', 'srcset', 'action', 'formaction', 'srcdoc', 'data', 'poster', 'background', 'xlink:href']);
const element = (tag, attributes, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes || {})) {
    if (FORBIDDEN_ATTRS.has(key.toLowerCase())) throw new Error('dom: forbidden attribute ' + key);
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value ?? '');
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'checked' || key === 'disabled' || key === 'required' || key === 'readOnly' || key === 'hidden' || key === 'open') node[key] = Boolean(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
};`;
  // The first line is positioned by the call site's own literal indentation;
  // indent applies to the remaining lines only.
  return indent ? source.split('\n').map((line, index) => index ? indent + line : line).join('\n') : source;
}
module.exports = { escapeAttribute, markupText, domHelpersSource };
