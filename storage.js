// storage.js — resilient JSON helpers (Vercel-safe)
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const IS_VERCEL = process.env.VERCEL === '1';
const ROOT_DIR = process.cwd();
const WRITE_DIR = IS_VERCEL ? '/tmp' : ROOT_DIR;

function resolvePath(filename) {
  const base = path.basename(filename || '');
  return path.join(WRITE_DIR, base || 'data.json');
}

async function loadJson(filename, fallback = {}) {
  const filePath = resolvePath(filename);
  try {
    const data = await fsp.readFile(filePath, 'utf8');
    try { return JSON.parse(data); } catch { return fallback; }
  } catch (err) {
    return fallback;
  }
}

async function saveJson(filename, obj = {}) {
  const filePath = resolvePath(filename);
  const tmpPath = `${filePath}.tmp`;
  try {
    const json = JSON.stringify(obj ?? {}, null, 2);
    await fsp.writeFile(tmpPath, json, 'utf8');
    await fsp.rename(tmpPath, filePath);
    return true;
  } catch (err) {
    try { await fsp.unlink(tmpPath); } catch {}
    return false;
  }
}

module.exports = { loadJson, saveJson };
