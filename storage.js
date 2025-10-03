// storage.js — resilient JSON helpers for Vercel serverless
// Uses write-through to /tmp in production and falls back gracefully.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// On Vercel, the only writeable path is /tmp
const IS_VERCEL = process.env.VERCEL === '1';
const ROOT_DIR = process.cwd();
const WRITE_DIR = IS_VERCEL ? '/tmp' : ROOT_DIR;

/**
 * Resolve a filename to a safe absolute path.
 * We deliberately avoid nested folders to keep it simple for serverless.
 */
function resolvePath(filename) {
  const base = path.basename(filename || '');
  return path.join(WRITE_DIR, base || 'data.json');
}

/**
 * Load a JSON file safely. Returns `fallback` if the file does not exist
 * or parsing fails. Never throws on read/parsing errors.
 */
async function loadJson(filename, fallback = {}) {
  const filePath = resolvePath(filename);
  try {
    const data = await fsp.readFile(filePath, 'utf8');
    try {
      return JSON.parse(data);
    } catch (parseErr) {
      console.warn(`JSON parse failed for ${filePath}, returning fallback.`, parseErr);
      return fallback;
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // File missing on first deploy — return fallback
      return fallback;
    }
    console.warn(`Read failed for ${filePath}, returning fallback.`, err);
    return fallback;
  }
}

/**
 * Save JSON safely. Writes atomically when possible.
 * Never throws — logs and returns false on failure.
 */
async function saveJson(filename, obj = {}) {
  const filePath = resolvePath(filename);
  const tmpPath = `${filePath}.tmp`;

  try {
    const json = JSON.stringify(obj ?? {}, null, 2);
    await fsp.writeFile(tmpPath, json, 'utf8');
    await fsp.rename(tmpPath, filePath);
    return true;
  } catch (err) {
    console.error(`Write failed for ${filePath}`, err);
    // Best-effort cleanup
    try { await fsp.unlink(tmpPath); } catch (_) {}
    return false;
  }
}

module.exports = { loadJson, saveJson };
