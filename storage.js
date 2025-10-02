const fs = require('fs');
const path = require('path');

function loadJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveJson(filePath, data) {
  try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch {}
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = { loadJson, saveJson };
