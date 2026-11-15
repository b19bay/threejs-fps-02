// serve.ts — tiny static dev server for game/ only (Node standard library).
// Usage: node serve.ts --port 8091   (default port 8080)
// Serves the game/ directory beside this file. Correct MIME types, refuses
// any path outside game/, no-store caching, nothing else clever.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const gameDir = resolve(join(root, 'game'));

const args = process.argv.slice(2);
let port = 8080;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) port = parseInt(args[i + 1], 10);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = resolve(join(gameDir, normalize(rel).replace(/^(\.\.[/\\])+/, '')));
    if (file !== gameDir && !file.startsWith(gameDir + sep)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404); res.end('not found'); return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'content-length': body.length,
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500); res.end('error');
  }
});

server.listen(port, () => {
  console.log(`serve.ts: serving game/ at http://localhost:${port}/`);
});
