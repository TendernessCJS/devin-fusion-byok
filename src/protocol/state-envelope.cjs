'use strict';

const { createHash } = require('node:crypto');

const STATE_PREFIX = 'dfbyok-responses-v1:';
const MAX_STATE_BYTES = 256 * 1024;
const SIZE_BUCKETS = [1024, 4096, 16384, 65536, MAX_STATE_BYTES];
const SIZE_BUCKET_LABELS = ['1k', '4k', '16k', '64k', '256k'];
function sizeBucket(bytes) {
  const index = SIZE_BUCKETS.findIndex(limit => bytes <= limit);
  return index === -1 ? 'over-max' : SIZE_BUCKET_LABELS[index];
}

function stateScope(provider, route) {
  return createHash('sha256').update(JSON.stringify([provider.id || '', provider.baseUrl || '', provider.apiKey || '', route.model])).digest('hex');
}
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  return value;
}
function sameArguments(left, right) {
  try { return JSON.stringify(canonicalize(JSON.parse(left))) === JSON.stringify(canonicalize(JSON.parse(right))); }
  catch { return false; }
}
// Replays a stored Responses output sequence only when it still describes this
// assistant turn byte-for-byte; every mismatch silently falls back to the
// regular projection.
function replayMatches(state, message) {
  let text = '';
  const tools = [];
  for (const item of state.items) {
    if (item?.type === 'message') for (const part of item.content || []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text;
      else return false;
    } else if (item?.type === 'function_call') tools.push({ id: item.call_id, name: item.name, arguments: item.arguments });
    else if (item?.type !== 'reasoning') return false;
  }
  if (text !== message.content) return false;
  const calls = message.toolCalls || [];
  if (tools.length !== calls.length) return false;
  for (const [index, tool] of tools.entries()) {
    if (tool.id !== calls[index].id || tool.name !== calls[index].name || !sameArguments(tool.arguments, calls[index].arguments)) return false;
  }
  return true;
}
function validStateItem(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.type === 'reasoning') return typeof item.encrypted_content === 'string' && item.encrypted_content !== '' && Array.isArray(item.summary);
  if (item.type === 'message') return item.role === 'assistant' && Array.isArray(item.content) &&
    item.content.every(part => part?.type === 'output_text' && typeof part.text === 'string');
  if (item.type === 'function_call') return typeof item.call_id === 'string' && item.call_id !== '' &&
    typeof item.name === 'string' && item.name !== '' && typeof item.arguments === 'string';
  return false;
}

module.exports = { STATE_PREFIX, MAX_STATE_BYTES, stateScope, canonicalize, sameArguments, replayMatches, validStateItem, sizeBucket };
