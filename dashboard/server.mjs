// Local dashboard. `node server.mjs --data <dir>` makes sure a server is running
// (starting a detached one if needed), opens the browser and exits.
// `--serve` runs the server itself. Binds to 127.0.0.1 only.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../scripts/db.mjs';
import { dataDir } from '../scripts/paths.mjs';
import { createApi } from './api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const DEFAULT_PORT = 4747;
const IDLE_SHUTDOWN_MS = 4 * 60 * 60 * 1000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

const stateFile = () => path.join(dataDir(), 'dashboard.json');

function ping(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 1000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try { resolve(JSON.parse(body).app === 'ouroboros'); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32'
    ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* the URL is printed anyway */ }
}

async function launch(args) {
  const state = (() => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return null; } })();
  let port = state?.port;
  if (!port || !(await ping(port))) {
    const child = spawn(process.execPath, ['--no-warnings', fileURLToPath(import.meta.url), '--serve', '--data', dataDir(), '--port', String(args.port || DEFAULT_PORT)], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    port = null;
    for (let i = 0; i < 50 && !port; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
        if (s.pid === child.pid && (await ping(s.port))) port = s.port;
      } catch { /* not ready */ }
    }
    if (!port) {
      console.error('Ouroboros dashboard did not start. See errors in the dashboard data dir.');
      process.exit(1);
    }
  }
  const url = `http://127.0.0.1:${port}/`;
  if (!args['no-open']) openBrowser(url);
  console.log(`Ouroboros dashboard: ${url}`);
}

function listen(server, port, attempts = 10) {
  return new Promise((resolve, reject) => {
    const tryPort = (p, left) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && left > 0) tryPort(p + 1, left - 1);
        else reject(err);
      });
      server.listen(p, '127.0.0.1', () => resolve(p));
    };
    tryPort(port, attempts);
  });
}

async function serve(args) {
  const db = openDb();
  const api = createApi(db);
  let lastRequest = Date.now();
  let port;

  const server = http.createServer((req, res) => {
    lastRequest = Date.now();
    // Reject DNS-rebinding: only our own loopback host names.
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url, `http://${host}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      try {
        const body = api(url.pathname.slice(5), url.searchParams);
        if (body === undefined) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err.message) }));
      }
      return;
    }

    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(publicDir, path.normalize(name));
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:",
    });
    fs.createReadStream(file).pipe(res);
  });

  port = await listen(server, Number(args.port) || DEFAULT_PORT);
  fs.writeFileSync(stateFile(), JSON.stringify({ port, pid: process.pid, startedAt: Date.now() }));

  setInterval(() => {
    if (Date.now() - lastRequest > IDLE_SHUTDOWN_MS) { server.close(); db.close(); process.exit(0); }
  }, 60_000).unref();
}

const args = parseArgs(process.argv.slice(2));
if (args.data) process.env.CLAUDE_PLUGIN_DATA = args.data;
if (args.serve) serve(args);
else launch(args);
