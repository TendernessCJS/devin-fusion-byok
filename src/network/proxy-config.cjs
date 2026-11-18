'use strict';
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

module.exports = { parseProxy };
