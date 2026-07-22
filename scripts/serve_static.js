const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const rootDir = path.resolve(__dirname, '..', 'dist');
const port = Number(process.env.PORT || 8080);
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function resolveRequestPath(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(rootDir, relativePath);
  return filePath.startsWith(`${rootDir}${path.sep}`) ? filePath : null;
}

const server = http.createServer((request, response) => {
  const filePath = resolveRequestPath(request.url);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, {
    'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(filePath).pipe(response);
});

server.listen(port, '0.0.0.0', () => {
  const addresses = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const network of interfaces || []) {
      if (network.family === 'IPv4' && !network.internal) addresses.push(network.address);
    }
  }
  console.log(`READY http://localhost:${port}`);
  for (const address of addresses) console.log(`LAN   http://${address}:${port}`);
});
