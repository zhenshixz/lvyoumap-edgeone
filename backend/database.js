const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const os = require('os');
const dbFilePath = path.join(__dirname, 'db.json');
const lockFilePath = path.join(os.tmpdir(), 'db.lock');
const DB_CRYPTO_KEY = crypto.scryptSync('china-tourism-map-secret-salt-2026', 'salt', 32);
const IV = Buffer.alloc(16, 0);
let cachedData = null;
let cachedMtimeMs = 0;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(maxRetries = 600, delay = 50) {
  const fsSync = require('fs');
  for (let i = 0; i < maxRetries; i++) {
    try {
      fsSync.writeFileSync(lockFilePath, process.pid.toString(), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
  throw new Error('Timeout acquiring database lock in database.js');
}

function releaseLock() {
  const fsSync = require('fs');
  try {
    if (fsSync.existsSync(lockFilePath)) {
      fsSync.unlinkSync(lockFilePath);
    }
  } catch (err) {
    // Ignore error
  }
}

async function readData() {
  try {
    const stat = await fs.stat(dbFilePath);
    if (cachedData && cachedMtimeMs === stat.mtimeMs) {
      return cachedData;
    }
  } catch (err) {
    console.error('Error checking database file:', err);
  }

  await acquireLock();
  try {
    const stat = await fs.stat(dbFilePath);
    if (cachedData && cachedMtimeMs === stat.mtimeMs) {
      return cachedData;
    }

    const data = await fs.readFile(dbFilePath, 'utf8');
    cachedData = JSON.parse(data);
    cachedMtimeMs = stat.mtimeMs;
    return cachedData;
  } catch (err) {
    console.error('Error reading database file:', err);
    return { provinces: {}, favorites: [], users: [] };
  } finally {
    releaseLock();
  }
}

async function writeData(data) {
  await acquireLock();
  try {
    await fs.writeFile(dbFilePath, JSON.stringify(data, null, 2), 'utf8');
    const stat = await fs.stat(dbFilePath);
    cachedData = data;
    cachedMtimeMs = stat.mtimeMs;
    
    // Synchronize frontend data files immediately
    const travelDataPath = path.join(__dirname, '..', 'travelData.json');
    const dataJsPath = path.join(__dirname, '..', 'data.js');
    await fs.writeFile(travelDataPath, JSON.stringify(data.provinces, null, 2), 'utf8');
    await fs.writeFile(dataJsPath, `window.tourismData = ${JSON.stringify(data.provinces, null, 2)};\n`, 'utf8');
    
    return true;
  } catch (err) {
    console.error('Error writing database file:', err);
    return false;
  } finally {
    releaseLock();
  }
}

async function getAllProvinces() {
  const data = await readData();
  const list = {};

  for (const name in data.provinces || {}) {
    const province = data.provinces[name];
    list[name] = {
      id: province.id,
      name: province.name,
      province: province.province,
      description: province.description,
      tags: province.tags,
      weather: province.weather,
      bestTime: province.bestTime,
      image: province.image,
      attractionCount: province.attractions ? province.attractions.length : 0,
    };
  }

  return list;
}

async function getProvinceByName(name) {
  const data = await readData();
  return data.provinces?.[name] || null;
}

async function searchAll(query) {
  if (!query) return [];

  const lowercaseQuery = query.toLowerCase().trim();
  const data = await readData();
  const results = [];

  for (const provinceName in data.provinces || {}) {
    const province = data.provinces[provinceName];
    const tags = Array.isArray(province.tags) ? province.tags : [];
    const description = province.description || '';
    const displayName = province.province || provinceName;

    const provinceMatches =
      displayName.toLowerCase().includes(lowercaseQuery) ||
      provinceName.toLowerCase().includes(lowercaseQuery) ||
      description.toLowerCase().includes(lowercaseQuery) ||
      tags.some((tag) => String(tag).toLowerCase().includes(lowercaseQuery));

    const matchingAttractions = [];
    for (const attraction of province.attractions || []) {
      const name = attraction.name || '';
      const intro = attraction.intro || '';
      const address = attraction.address || '';
      const level = attraction.level || '';

      if (
        name.toLowerCase().includes(lowercaseQuery) ||
        intro.toLowerCase().includes(lowercaseQuery) ||
        address.toLowerCase().includes(lowercaseQuery) ||
        level.toLowerCase().includes(lowercaseQuery)
      ) {
        matchingAttractions.push(attraction);
      }
    }

    if (provinceMatches || matchingAttractions.length > 0) {
      results.push({
        province: displayName,
        provinceId: province.id,
        matchedProvince: provinceMatches,
        attractions: matchingAttractions,
      });
    }
  }

  return results;
}

function encryptField(text) {
  if (!text) return text;

  try {
    const cipher = crypto.createCipheriv('aes-256-cbc', DB_CRYPTO_KEY, IV);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `enc:${encrypted}`;
  } catch {
    return text;
  }
}

function decryptField(text) {
  if (!text || !text.startsWith('enc:')) return text;

  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', DB_CRYPTO_KEY, IV);
    let decrypted = decipher.update(text.substring(4), 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return text;
  }
}

async function getFavorites(userId) {
  const data = await readData();
  if (!userId) return [];

  return (data.favorites || [])
    .filter((favorite) => favorite.userId === userId)
    .map((favorite) => ({
      ...favorite,
      attractionName: decryptField(favorite.attractionName),
      attractionImage: decryptField(favorite.attractionImage),
    }));
}

async function addFavorite(userId, provinceId, attractionId, attractionName, attractionImage, level) {
  const data = await readData();
  if (!userId || !attractionId) return null;
  if (!Array.isArray(data.favorites)) data.favorites = [];

  const existing = data.favorites.find(
    (favorite) => favorite.userId === userId && favorite.attractionId === attractionId,
  );

  if (existing) {
    return {
      ...existing,
      attractionName: decryptField(existing.attractionName),
      attractionImage: decryptField(existing.attractionImage),
    };
  }

  const newFavorite = {
    id: `fav_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
    userId,
    provinceId,
    attractionId,
    attractionName: encryptField(attractionName),
    attractionImage: encryptField(attractionImage),
    level,
    createdAt: new Date().toISOString(),
  };

  data.favorites.push(newFavorite);
  const success = await writeData(data);

  return success
    ? {
        ...newFavorite,
        attractionName,
        attractionImage,
      }
    : null;
}

async function removeFavorite(userId, id) {
  const data = await readData();
  if (!Array.isArray(data.favorites)) data.favorites = [];

  const initialLength = data.favorites.length;
  data.favorites = data.favorites.filter(
    (favorite) => !(favorite.userId === userId && (favorite.id === id || favorite.attractionId === id)),
  );

  const success = await writeData(data);
  return success && data.favorites.length < initialLength;
}

module.exports = {
  readData,
  writeData,
  getAllProvinces,
  getProvinceByName,
  searchAll,
  getFavorites,
  addFavorite,
  removeFavorite,
};
