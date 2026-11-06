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

// Whether a provider error body names an exhausted balance/quota. Every pattern
// is taken verbatim from the reference upstream classifier
// (.refs/WindsurfAPI/src/devin-connect.js: classifyUpstreamError, QUOTA branch),
// including "…quota has been exhausted" — the live body a narrower
// `quota exceeded` pattern used to miss. The `insufficient` arm is the one
// rewrite: the reference uses an unbounded `.*`, we bound it to 40 chars and
// forbid `.` so two unrelated JSON fields cannot pair up. Returns a fixed enum
// token, never the detail itself.
function classifyQuotaDetail(detail) {
  if (typeof detail !== 'string' || !detail) return null;
  // A structured exact code wins outright: it cannot be confused with the
  // rate-limit wording the text heuristics must guard against.
  try {
    const parsed = JSON.parse(detail);
    if (parsed?.error?.code === 'insufficient_quota' || parsed?.code === 'insufficient_quota') {
      return 'quota-exhausted';
    }
  } catch { /* not JSON — fall through to the text heuristics */ }
  const body = detail.toLowerCase();
  // A windowed rate limit can mention "quota" too (Gemini: "Quota exceeded for
  // quota metric … per minute"). The reference classifier ranks rate-limit
  // signals ahead of the quota branch, so keep those retryable.
  if (/(?:rate[_ ]limit|too many requests|retry[- ]after|per[ _-]?(?:second|sec|minute|min)\b)/.test(body)) return null;
  const quota = /insufficient[^.]{0,40}(credit|quota|balance|funds)/.test(body)
    || /out of (credit|quota|balance|funds)/.test(body)
    || /(credit|quota|balance|allowance|usage)[\s\w-]{0,40}?(exceeded|exhausted|depleted|used up)/.test(body)
    || /on.?demand[^.]{0,60}(exhausted|exceeded|depleted|out of|insufficient)/.test(body)
    || /run(?:ning)? out of (credit|quota|balance|funds|usage)/.test(body);
  return quota ? 'quota-exhausted' : null;
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

module.exports = { MAX_SSE_BUFFER, readErrorDetail, parseEvent, events, usageSnapshot, classifyErrorDetail, classifyQuotaDetail };
