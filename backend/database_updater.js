const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'db.json');
const travelDataPath = path.join(__dirname, '..', 'travelData.json');
const dataJsPath = path.join(__dirname, '..', 'data.js');
const lockPath = path.join(__dirname, 'db.lock');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(maxRetries = 600, delay = 200) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      fs.writeFileSync(lockPath, process.pid.toString(), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
  throw new Error('Timeout acquiring database lock');
}

function releaseLock() {
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch (err) {
    // Ignore error
  }
}

/**
 * Perform an atomic read-modify-write on db.json and synchronize frontend data.
 * @param {Function} updateFn - Function that modifies the db object in-place. If it returns false, writing is skipped.
 */
async function atomicUpdateDb(updateFn) {
  await acquireLock();
  try {
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const result = await updateFn(db);
    if (result !== false) {
      fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
      fs.writeFileSync(travelDataPath, JSON.stringify(db.provinces, null, 2), 'utf8');
      fs.writeFileSync(dataJsPath, `window.tourismData = ${JSON.stringify(db.provinces, null, 2)};\n`, 'utf8');
    }
  } finally {
    releaseLock();
  }
}

module.exports = {
  atomicUpdateDb,
};
