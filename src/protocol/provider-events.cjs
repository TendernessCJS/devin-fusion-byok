'use strict';

const MAX_SSE_BUFFER = 64 * 1024 * 1024;

// Bounded read of an error response, used only to classify a refusal. The text
// is never logged or forwarded — it just decides whether one retry is worth it.
async function readErrorDetail(response, limit = 4096) {
  try {
    const reader = response.body?.getReader();
    if (!reader) return '';
    try {
      let text = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString('utf8');
        if (text.length >= limit) { try { await reader.cancel(); } catch { /* already drained */ } break; }
      }
      return text.slice(0, limit);
    } finally {
      try { reader.releaseLock(); } catch { /* lock may already be released */ }
    }
  } catch { return ''; }
}

function parseEvent(raw) {
  let event = '';
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).replace(/^ /, '');
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return null;
  const joined = data.join('\n');
  if (joined.trim() === '[DONE]') return { type: 'done' };
  let value;
  try {
    value = JSON.parse(joined);
  } catch {
    const err = new Error('Invalid SSE event JSON');
    err.code = 'upstream_invalid_json';
    throw err;
  }
  return { type: value.type || event, data: value };
}

async function* events(body, { maxBufferCharacters = MAX_SSE_BUFFER } = {}) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '', frameLines = [], frameChars = 0;
  // A bare CR ends a line too; when it is the last byte of a chunk the line
  // ending may continue as CRLF into the next chunk, so a leading LF there is
  // part of the same terminator, not an extra blank line.
  let skipLF = false;
  function checkSize(characters) {
    if (characters > maxBufferCharacters) {
      const err = new Error('SSE frame too large');
      err.code = 'upstream_content_type';
      throw err;
    }
  }
  function endLine(completed) {
    frameLines.push(completed);
    frameChars += completed.length + 1;
    checkSize(frameChars);
    if (completed !== '') return null;
    const raw = frameLines.join('\n');
    frameLines = [];
    frameChars = 0;
    return parseEvent(raw);
  }
  for await (const chunk of body) {
    const text = decoder.decode(chunk, { stream: true });
    for (const ch of text) {
      if (skipLF) {
        skipLF = false;
        if (ch === '\n') continue;
      }
      if (ch === '\r') {
        skipLF = true;
        const event = endLine(line);
        line = '';
        if (event) yield event;
      } else if (ch === '\n') {
        const event = endLine(line);
        line = '';
        if (event) yield event;
      } else {
        line += ch;
        checkSize(frameChars + line.length);
      }
    }
  }
  line += decoder.decode();
  checkSize(frameChars + line.length);
  if (line) frameLines.push(line);
  const raw = frameLines.join('\n');
  if (raw.trim()) { const event = parseEvent(raw); if (event) yield event; }
}

// Whether a provider error body merely mentions signatures — a triage hint,
// not proof of cause. Returns a fixed enum token, never the detail itself.
function classifyErrorDetail(detail) {
  return typeof detail === 'string' && /signature/i.test(detail) ? 'signature-mentioned' : null;
}

function usageSnapshot(data, chat) {
  const usage = chat ? data?.usage : data?.response?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const input = chat ? usage.prompt_tokens : usage.input_tokens;
  const output = chat ? usage.completion_tokens : usage.output_tokens;
  if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0) return null;
  // input_tokens is INCLUSIVE of cached tokens; the cache fields are subsets.
  const details = chat ? usage.prompt_tokens_details : usage.input_tokens_details;
  const cacheRead = details?.cached_tokens ?? (chat ? usage.prompt_cache_hit_tokens : undefined);
  const cacheWrite = chat ? details?.cache_creation_tokens : undefined;
  const snapshot = { inputTokens: input, outputTokens: output };
  if (Number.isSafeInteger(cacheRead) && cacheRead >= 0) snapshot.cacheReadTokens = cacheRead;
  if (Number.isSafeInteger(cacheWrite) && cacheWrite >= 0) snapshot.cacheWriteTokens = cacheWrite;
  return snapshot;
}

module.exports = { MAX_SSE_BUFFER, readErrorDetail, parseEvent, events, usageSnapshot, classifyErrorDetail };
