const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./database');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const lazyRouteProgressPath = path.join(__dirname, 'lazy_route_update_progress.json');
const lazyRouteStopFlagPath = path.join(__dirname, 'lazy_route_update_stop.flag');
const lazyRouteUpdaterPath = path.join(__dirname, 'update_lazy_routes_global.js');
const enableOnDemandImageFetch = process.env.ENABLE_ON_DEMAND_IMAGE_FETCH === '1';

// Enable CORS for development flexibility
app.use(cors());
// Parse JSON request bodies
app.use(express.json());

function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function setSharedCache(res, seconds, staleSeconds = 604800) {
  res.setHeader('Cache-Control', `public, max-age=${seconds}, s-maxage=${seconds}, stale-while-revalidate=${staleSeconds}`);
  res.removeHeader('Pragma');
  res.removeHeader('Expires');
}

function setStaticCacheHeaders(res, filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.includes('/data/') || normalized.endsWith('/china_geo.js') || normalized.endsWith('/china.json')) {
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
    return;
  }

  if (normalized.includes('/assets/') || normalized.includes('/vendor/')) {
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800');
  }
}

// Dynamic user APIs stay uncached; read-only travel APIs can be shared by CDN.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' && (req.path === '/provinces' || req.path.startsWith('/provinces/'))) {
    setSharedCache(res, 3600);
  } else if (req.method === 'GET' && req.path === '/search') {
    setSharedCache(res, 300);
  } else if (req.method === 'GET' && req.path === '/weather') {
    setSharedCache(res, 900, 3600);
  } else {
    setNoStore(res);
  }
  next();
});

// API Endpoints

/**
 * GET /api/provinces
 * Returns a lightweight index list of all 34 provinces for initial client map rendering
 */
app.get('/api/provinces', async (req, res) => {
  try {
    const list = await db.getAllProvinces();
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/provinces/:name
 * Returns the detailed data of a single province (attractions, foods, routes)
 */
app.get('/api/provinces/:name', async (req, res) => {
  try {
    const detail = await db.getProvinceByName(req.params.name);
    if (!detail) {
      return res.status(404).json({ success: false, message: "Province not found" });
    }
    res.json({ success: true, data: detail });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/search
 * Searches across provinces, descriptions, tags, and attraction names
 */
app.get('/api/search', async (req, res) => {
  try {
    const results = await db.searchAll(req.query.q);
    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function readLazyRouteProgress() {
  let progress = {
    status: 'idle',
    message: '尚未启动懒人攻略更新',
    total: 0,
    completed: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    percent: 0,
  };

  try {
    if (fs.existsSync(lazyRouteProgressPath)) {
      progress = { ...progress, ...JSON.parse(fs.readFileSync(lazyRouteProgressPath, 'utf8')) };
    }
  } catch (err) {
    progress.message = `进度文件读取失败：${err.message}`;
  }

  try {
    const dbFilePath = path.join(__dirname, 'db.json');
    const dbData = JSON.parse(fs.readFileSync(dbFilePath, 'utf8'));
    let totalAttractions = 0;
    let verifiedAttractions = 0;

    for (const province of Object.values(dbData.provinces || {})) {
      for (const attraction of province.attractions || []) {
        totalAttractions += 1;
        if (Array.isArray(attraction.lazy_routes) && attraction.lazy_routes.length >= 2) {
          verifiedAttractions += 1;
        }
      }
    }

    progress.totalAttractions = totalAttractions;
    progress.verifiedAttractions = verifiedAttractions;
    progress.missingAttractions = Math.max(totalAttractions - verifiedAttractions, 0);
  } catch {
    // Keep progress endpoint usable even while db.json is being written.
  }

  return progress;
}

app.get('/api/lazy-route-update/progress', (req, res) => {
  res.json({ success: true, data: readLazyRouteProgress() });
});

app.post('/api/lazy-route-update/start', (req, res) => {
  try {
    const current = readLazyRouteProgress();
    const updatedAt = current.updatedAt ? Date.parse(current.updatedAt) : 0;
    const recentlyRunning = current.status === 'running' && Date.now() - updatedAt < 120000;

    if (recentlyRunning) {
      return res.json({ success: true, alreadyRunning: true, data: current });
    }

    if (!fs.existsSync(lazyRouteUpdaterPath)) {
      return res.status(500).json({ success: false, message: 'update_lazy_routes_global.js 不存在' });
    }

    if (fs.existsSync(lazyRouteStopFlagPath)) {
      fs.unlinkSync(lazyRouteStopFlagPath);
    }

    const body = req.body || {};
    const args = [lazyRouteUpdaterPath];

    if (body.force === true) args.push('--force');
    if (body.dryRun === true) args.push('--dry-run');
    if (body.limit && Number.isFinite(Number(body.limit))) args.push(`--limit=${Math.max(1, Number(body.limit))}`);
    if (body.province) args.push(`--province=${String(body.province)}`);
    if (body.only) args.push(`--only=${String(body.only)}`);

    const child = spawn(process.execPath, args, {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });

    child.unref();

    res.json({
      success: true,
      pid: child.pid,
      message: '懒人攻略后台更新已启动',
      data: readLazyRouteProgress(),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/lazy-route-update/stop', (req, res) => {
  try {
    fs.writeFileSync(lazyRouteStopFlagPath, String(Date.now()), 'utf8');
    res.json({ success: true, message: '已请求停止，脚本会在当前景点处理完成后退出' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/favorites
 * Gets the list of favorited attractions for a user
 */
app.get('/api/favorites', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ success: false, message: "userId query parameter is required" });
    }
    const list = await db.getFavorites(userId);
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/favorites
 * Adds an attraction to the user's favorites list
 */
app.post('/api/favorites', async (req, res) => {
  try {
    const { userId, provinceId, attractionId, attractionName, attractionImage, level } = req.body;
    if (!userId || !attractionId) {
      return res.status(400).json({ success: false, message: "userId and attractionId are required" });
    }
    const fav = await db.addFavorite(userId, provinceId, attractionId, attractionName, attractionImage, level);
    res.json({ success: true, data: fav });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/favorites/:id
 * Removes a favorite entry (either by DB favorite id or by attractionId)
 */
app.delete('/api/favorites/:id', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ success: false, message: "userId query parameter is required" });
    }
    const success = await db.removeFavorite(userId, req.params.id);
    res.json({ success, message: success ? "Removed from favorites" : "Favorite not found or failed to delete" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/weather
 * Returns live real-time weather of a province or falls back gracefully to a high-fidelity simulator.
 */
app.get('/api/weather', async (req, res) => {
  const { province } = req.query;
  if (!province) {
    return res.status(400).json({ success: false, message: "province parameter is required" });
  }

  // 1. Try real-time query from wttr.in (2s timeout limit for fast performance)
  try {
    const url = `https://wttr.in/${encodeURIComponent(province)}?format=j1`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (response.ok) {
      const weatherData = await response.json();
      const current = weatherData.current_condition[0];
      const temp = `${current.temp_C}°C`;
      const desc = current.weatherDesc[0].value.toLowerCase();
      
      let cond = "晴";
      if (desc.includes("rain") || desc.includes("drizzle") || desc.includes("shower")) cond = "雨";
      else if (desc.includes("snow") || desc.includes("sleet") || desc.includes("flurry")) cond = "雪";
      else if (desc.includes("cloud") || desc.includes("overcast")) cond = "阴";
      else if (desc.includes("mist") || desc.includes("fog") || desc.includes("haze")) cond = "雾";
      else if (desc.includes("partly cloudy") || desc.includes("sunny")) cond = "多云";

      let aqiVal = Math.floor(Math.random() * 35) + 15;
      if (cond === "雾") aqiVal += 45;
      let aqiStr = `优 ${aqiVal}`;
      if (aqiVal > 50) aqiStr = `良 ${aqiVal}`;

      return res.json({
        success: true,
        source: "live",
        data: { temp, cond, aqi: aqiStr }
      });
    }
  } catch (err) {
    console.log(`Live weather query timed out or skipped for ${province}. Loading high-fidelity simulator.`);
  }

  // 2. High-fidelity simulator fallback based on date, time and default parameters
  try {
    const detail = await db.getProvinceByName(province);
    const fallback = detail ? detail.weather : { temp: "22°C", cond: "晴", aqi: "优 35" };
    
    let tempNum = parseInt(fallback.temp);
    if (isNaN(tempNum)) tempNum = 20;

    const month = new Date().getMonth();
    if (month >= 11 || month <= 1) { // Winter
      tempNum -= 10;
      if (province === "黑龙江" || province === "吉林" || province === "辽宁") {
        tempNum = -Math.floor(Math.random() * 12) - 6;
      }
    } else if (month >= 5 && month <= 7) { // Summer
      tempNum += 8;
    }

    const hour = new Date().getHours();
    let diurnal = 0;
    if (hour < 6 || hour > 20) diurnal = -4; // Cooler at night
    else if (hour >= 11 && hour <= 15) diurnal = 3;  // Warmer at noon

    res.json({
      success: true,
      source: "simulator",
      data: {
        temp: `${tempNum + diurnal}°C`,
        cond: fallback.cond,
        aqi: fallback.aqi
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const JWT_SECRET = 'china-tourism-map-secure-key-2026';

/**
 * Standard JWT Token Generator (Zero-Dependency HMCA-SHA256)
 */
function generateToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 86400000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

/**
 * Standard JWT Token Verifier
 */
function verifyToken(token) {
  try {
    const [header, body, signature] = token.split('.');
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    if (signature !== expectedSig) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp < Date.now()) return null; 
    return payload;
  } catch (e) {
    return null;
  }
}

const crypto = require('crypto');

/**
 * POST /api/auth/register
 * Salted-hash SHA-256 user registration API
 */
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: "手机号和密码不能为空" });
    }
    
    const dbData = await db.readData();
    if (!dbData.users) dbData.users = [];
    
    const exists = dbData.users.find(u => u.username === username);
    if (exists) {
      return res.status(400).json({ success: false, message: "该手机号已被注册" });
    }
    
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.createHmac('sha256', salt).update(password).digest('hex');
    
    const newUser = {
      id: 'usr_' + Math.random().toString(36).substr(2, 9),
      username,
      salt,
      hash,
      createdAt: new Date().toISOString()
    };
    
    dbData.users.push(newUser);
    await db.writeData(dbData);
    
    const token = generateToken({ userId: newUser.id, username: newUser.username });
    
    res.json({
      success: true,
      message: "注册成功",
      data: {
        token,
        userId: newUser.id,
        username: newUser.username
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/auth/login
 * User credentials verification returning standard JWT session
 */
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: "手机号和密码不能为空" });
    }
    
    const dbData = await db.readData();
    if (!dbData.users) dbData.users = [];
    
    const user = dbData.users.find(u => u.username === username);
    if (!user) {
      return res.status(401).json({ success: false, message: "该手机号尚未注册" });
    }
    
    const hash = crypto.createHmac('sha256', user.salt).update(password).digest('hex');
    if (hash !== user.hash) {
      return res.status(401).json({ success: false, message: "密码输入错误，请重试" });
    }
    
    const token = generateToken({ userId: user.id, username: user.username });
    res.json({
      success: true,
      message: "登录成功",
      data: {
        token,
        userId: user.id,
        username: user.username
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});



// =========================================================
// 🚀 即时按需图片下载与爬虫机制 (On-Demand Real-Time Image Scraper & Downloader)
// =========================================================

async function fetchImageFrom360(query) {
  try {
    const res = await fetch('https://image.so.com/j?q=' + encodeURIComponent(query) + '&src=srp&sn=0&pn=5', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const data = await res.json();
    if (data.list && data.list.length > 0) {
      for (let item of data.list) {
        const url = item.imgurl || item.thumb;
        if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
          return url;
        }
      }
    }
  } catch (e) {
    console.error(`[On-Demand Scraper] 360 Search API Error for query "${query}":`, e.message);
  }
  return null;
}

async function fetchImageFromAPI(query) {
  try {
    const res = await fetch('https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&fp=result&word=' + encodeURIComponent(query) + '&num=5', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/plain, */*; q=0.01',
        'Referer': 'https://image.baidu.com/search/index?tn=baiduimage&ps=1&ct=201326592&lm=-1&cl=2&nc=1&ie=utf-8&word=' + encodeURIComponent(query)
      }
    });
    const data = await res.json();
    if (data.data && data.data.length > 0) {
      for (let item of data.data) {
        const url = item.hoverURL || item.middleURL || item.thumbURL;
        if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
          return url;
        }
      }
    }
  } catch (e) {
    console.error(`[On-Demand Scraper] Baidu API Error for query "${query}". Trying 360 Image Search fallback...`);
  }
  
  // High-fidelity fallback to 360 Image Search
  return await fetchImageFrom360(query);
}

function downloadImage(url, destPath) {
  return new Promise((resolve) => {
    const file = fs.createWriteStream(destPath);
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 8000
    }, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        return resolve(false);
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(true);
      });
    });
    req.on('error', () => {
      file.close();
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      resolve(false);
    });
    req.setTimeout(8000, () => {
      req.destroy();
    });
  });
}

app.use('/assets/images', async (req, res, next) => {
  const filePath = path.join(__dirname, '../assets/images', req.path);

  if (!enableOnDemandImageFetch) {
    return next();
  }
  
  try {
    // If file already exists and is not empty, serve it
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1000) {
      return next();
    }
    
    // File does not exist! Let's check db.json to find its Chinese name
    const dbFilePath = path.join(__dirname, 'db.json');
    if (!fs.existsSync(dbFilePath)) return next();
    
    const dbData = JSON.parse(fs.readFileSync(dbFilePath, 'utf8'));
    let searchName = null;
    let searchType = '';
    
    const targetUrl = `/assets/images${req.path.replace(/\\/g, '/')}`.split('?')[0];
    
    outerLoop:
    for (const pName in dbData.provinces) {
      const p = dbData.provinces[pName];
      if (p.image === targetUrl) {
        searchName = pName;
        searchType = '省份风景';
        break;
      }
      if (p.attractions) {
        for (const a of p.attractions) {
          if (a.image === targetUrl) {
            searchName = a.name;
            searchType = '景区 真实风景';
            break outerLoop;
          }
        }
      }
      if (p.foods) {
        for (const f of p.foods) {
          if (f.image === targetUrl) {
            searchName = f.name;
            searchType = '传统特色美食';
            break outerLoop;
          }
        }
      }
    }
    
    // Support dynamic extraction from filename
    const filename = path.basename(req.path);
    if (filename.startsWith('dynamic_food_')) {
      searchName = decodeURIComponent(filename.replace('dynamic_food_', '').replace('.jpg', ''));
      searchType = '特写 高清';
    } else if (filename.startsWith('dynamic_hotel_')) {
      searchName = decodeURIComponent(filename.replace('dynamic_hotel_', '').replace('.jpg', ''));
      searchType = '酒店 客房 高清';
    }
    
    if (!searchName) {
      return next();
    }
    
    console.log(`[On-Demand Scraper] Intercepted missing image request: ${req.path} ➔ Found DB item: "${searchName}" (${searchType}). Triggering real-time crawler...`);
    
    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    
    // Fetch and download
    const query = `${searchName} ${searchType}`;
    const url = await fetchImageFromAPI(query);
    if (url) {
      console.log(`[On-Demand Scraper] Found URL for "${searchName}": ${url}. Downloading...`);
      const success = await downloadImage(url, filePath);
      if (success) {
        console.log(`[On-Demand Scraper] Dynamic download complete for "${searchName}" ➔ ${req.path}`);
        return res.sendFile(filePath);
      }
    }
    
    console.log(`[On-Demand Scraper] Dynamic download failed for "${searchName}". Falling back to static server.`);
    next();
  } catch (err) {
    console.error(`[On-Demand Scraper] Middleware Error:`, err);
    next();
  }
});

// Serve frontend assets statically
app.use(express.static(path.join(__dirname, '../'), {
  setHeaders: setStaticCacheHeaders,
}));

app.get('/assets/images/*', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
  res.sendFile(path.join(__dirname, '../assets/images/default-thumbnail.jpg'));
});

// Serve index.html for any other paths (SPA fallback)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'));
});

// Start listening
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    // 动态获取内网物理网卡 IP 地址 (优先 192.x 段)
    const os = require('os');
    let localIp = '127.0.0.1';
    const ifs = os.networkInterfaces();
    outerLoop: for (const n in ifs) {
      for (const net of ifs[n]) {
        if (net.family === 'IPv4' && !net.internal) {
          if (net.address.startsWith('192.')) {
            localIp = net.address;
            break outerLoop;
          }
          localIp = net.address;
        }
      }
    }

    console.log(`=================================================`);
    console.log(`🚀 China Tourism Map Commercial Server is running!`);
    console.log(`👉 Local PC Access:    http://localhost:${PORT}`);
    console.log(`👉 Android/LAN Access: http://${localIp}:${PORT}`);
    console.log(`=================================================`);
  });
}

module.exports = app;
