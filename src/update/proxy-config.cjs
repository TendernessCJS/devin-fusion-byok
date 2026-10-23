'use strict';
// Echo form for panel editing: credential-bearing proxies are masked so
// secrets never reach the webview; saving the mask back is a no-op.
function maskProxy(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const trimmed = value.trim();
  let url;
  try { url = new URL(trimmed); } catch { return ''; }
  if (!url.username && !url.password) return trimmed;
  return `${url.protocol}//***@${url.host}`;
}

function parseProxy(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url;
  try { url = new URL(value); } catch { throw Error('proxy'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw Error('proxy');
  if (!url.hostname || (url.port && (!/^\d+$/.test(url.port) || Number(url.port) > 65535))) throw Error('proxy');
  let authorization;
  if (url.username || url.password) {
    try { authorization = 'Basic ' + Buffer.from(decodeURIComponent(url.username) + ':' + decodeURIComponent(url.password), 'utf8').toString('base64'); }
    catch { throw Error('proxy'); }
  }
  return { url, authorization };
}

module.exports = { parseProxy, maskProxy };
