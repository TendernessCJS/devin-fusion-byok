'use strict';
function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
// Browser-side helpers shared by every webview. Standalone documents emit this
// once inside their own script; the main panel emits it once at the top level
// of its <script> — panelClient is serialized via toString() and picks these
// up from the enclosing scope, so it must not declare them again.
function domHelpersSource(indent = '') {
  const source = `const byId = (id, prefix = '') => document.getElementById(prefix + id);
const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
const element = (tag, attributes, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes || {})) {
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
module.exports = { escapeAttribute, domHelpersSource };
