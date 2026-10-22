'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const STALE_MS = 30000;

function readDoc(file) {
  const text = fs.readFileSync(file, 'utf8');
  let doc;
  try { doc = JSON.parse(text); }
  catch {
    const error = new Error('Config file is corrupt');
    error.code = 'config_corrupt';
    throw error;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    const error = new Error('Config file is corrupt');
    error.code = 'config_corrupt';
    throw error;
  }
  return { doc, revision: Number.isSafeInteger(doc?.configRevision) ? doc.configRevision : 0 };
}

function lockInfo(file) {
  try { return fs.readFileSync(file + '.lock', 'utf8'); } catch { return null; }
}

function acquire(file, timeoutMs) {
  const lockPath = file + '.lock';
  const payload = JSON.stringify({ pid: process.pid, time: Date.now() });
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  let steals = 0;
  for (;;) {
    let fd;
    try { fd = fs.openSync(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (steals === 0) {
        const content = lockInfo(file);
        if (content !== null) {
          let stale = false, malformed = false;
          try {
            const info = JSON.parse(content);
            if (typeof info.pid !== 'number' || typeof info.time !== 'number') malformed = true;
            else {
              try { process.kill(info.pid, 0); } catch (kill) { stale = kill.code === 'ESRCH'; }
              if (!stale && Date.now() - info.time > STALE_MS) stale = true;
            }
          } catch { malformed = true; }
          // An empty or unparseable lock may be a holder that died between
          // creating the file and writing its payload — or a live holder still
          // inside that window. Only mtime age distinguishes them.
          if (malformed) {
            try { stale = Date.now() - fs.statSync(lockPath).mtimeMs > STALE_MS; } catch {}
          }
          if (stale) {
            try {
              if (lockInfo(file) === content) { fs.unlinkSync(lockPath); steals++; continue; }
            } catch {}
          }
        }
      }
      if (Date.now() >= deadline) {
        const error = new Error('Config file is busy');
        error.code = 'config_busy';
        throw error;
      }
      Atomics.wait(pause, 0, 0, Math.min(5 + Math.floor(Math.random() * 16), Math.max(1, deadline - Date.now())));
      continue;
    }
    try {
      fs.writeSync(fd, payload);
      fs.fsyncSync(fd);
    } catch (error) {
      try { if (lockInfo(file) === payload) fs.unlinkSync(lockPath); } catch {}
      throw error;
    } finally { try { fs.closeSync(fd); } catch {} }
    return payload;
  }
}

function release(file, payload) {
  try { if (lockInfo(file) === payload) fs.unlinkSync(file + '.lock'); } catch {}
}

function writeTmp(target, bytes) {
  const tmp = target + '.' + crypto.randomBytes(8).toString('hex');
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally { try { fs.closeSync(fd); } catch {} }
    return tmp;
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function updateConfig(file, mutator, { timeoutMs = 3000, fromEmpty = false } = {}) {
  const payload = acquire(file, timeoutMs);
  const temps = [];
  try {
    let doc, revision = 0, oldBytes = null;
    try {
      oldBytes = fs.readFileSync(file);
      ({ doc, revision } = readDoc(file));
    } catch (error) {
      if (error.code === 'ENOENT') doc = {};
      else if (error.code === 'config_corrupt' && fromEmpty) { doc = {}; oldBytes = null; }
      else throw error;
    }
    if (mutator(doc) === false) return { doc, revision, changed: false };
    doc.configRevision = revision + 1;
    try {
      temps.push(writeTmp(file, JSON.stringify(doc, null, 2)));
      if (oldBytes !== null) {
        temps.push(writeTmp(file + '.bak', oldBytes));
        fs.renameSync(temps.pop(), file + '.bak');
      }
      fs.renameSync(temps.pop(), file);
      try {
        const dirFd = fs.openSync(path.dirname(file), 'r');
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      } catch {}
    } catch (error) {
      for (const tmp of temps.splice(0)) { try { fs.unlinkSync(tmp); } catch {} }
      const wrapped = new Error('Config write failed');
      wrapped.code = 'config_write_failed';
      wrapped.cause = error;
      throw wrapped;
    }
    return { doc, revision: doc.configRevision, changed: true };
  } finally {
    release(file, payload);
  }
}

function applyKeyDelta(doc, next, baseline) {
  let changed = false;
  const keys = new Set([...Object.keys(baseline || {}), ...Object.keys(next || {})]);
  for (const key of keys) {
    if (key === 'configRevision') continue;
    if (isDeepStrictEqual(next?.[key], baseline?.[key])) continue;
    if (next && Object.hasOwn(next, key)) {
      if (!isDeepStrictEqual(doc[key], next[key])) { doc[key] = structuredClone(next[key]); changed = true; }
    } else if (Object.hasOwn(doc, key)) {
      delete doc[key];
      changed = true;
    }
  }
  return changed;
}

function archiveCorrupt(file) {
  try { fs.renameSync(file, file + '.corrupt-' + new Date().toISOString().replace(/:/g, '')); } catch {}
}

function recoverFromBackup(file) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file + '.bak', 'utf8')); } catch { return null; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  archiveCorrupt(file);
  return { doc };
}

module.exports = { readDoc, updateConfig, applyKeyDelta, archiveCorrupt, recoverFromBackup };
