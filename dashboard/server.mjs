// Local dashboard. `node server.mjs --data <dir>` makes sure a server is running
// (starting a detached one if needed), opens the browser and exits.
// `--serve` runs the server itself. Binds to 127.0.0.1 only.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcile } from '../scripts/curator.mjs';
import { logError, openDb } from '../scripts/db.mjs';
import { dataDir } from '../scripts/paths.mjs';
import { createApi } from './api.mjs';
import { runAction } from './actions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const DEFAULT_PORT = 4747;
const IDLE_SHUTDOWN_MS = 4 * 60 * 60 * 1000;
const CSP = "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
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

/**
 * Fingerprint of the code a server runs (file names + modification times). A server
 * started before the plugin was updated serves a stale API next to fresh static
 * files; the fingerprint lets the launcher replace it and the server retire itself.
 */
export function codeVersion() {
  const dirs = [here, publicDir, path.join(here, '..', 'scripts')];
  const parts = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir).sort(); } catch { continue; }
    for (const name of names) {
      try {
        const st = fs.statSync(path.join(dir, name));
        if (st.isFile()) parts.push(`${name}:${Math.round(st.mtimeMs)}:${st.size}`);
      } catch { /* vanished */ }
    }
  }
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

function ping(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 1000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(j.app === 'ouroboros' ? j : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** Stops the server a ping answered for: the pid comes from the ping, never from a file that may be stale. */
async function stopServer(running, port) {
  if (Number.isInteger(running.pid)) { try { process.kill(running.pid); } catch { /* already gone */ } }
  for (let i = 0; i < 30 && (await ping(port)); i++) await new Promise((r) => setTimeout(r, 100));
}

/** The same data directory, however it is spelled. */
const sameDir = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

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
  // Only a server that serves this data directory is ours; another install's server on that port is left alone.
  const found = port ? await ping(port) : null;
  const running = found && sameDir(found.data, dataDir()) ? found : null;
  if (running && running.version !== codeVersion()) {
    await stopServer(running, port);
    console.log('Restarted the dashboard server: the plugin code changed since it started.');
  }
  if (!running || running.version !== codeVersion()) {
    const child = spawn(process.execPath, ['--no-warnings', fileURLToPath(import.meta.url), '--serve', '--data', dataDir(), '--port', String(args.port || state?.port || DEFAULT_PORT)], {
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
      // One listener pair per attempt: a failed attempt's "listening" callback must not
      // resolve with its port when a later attempt succeeds.
      const onListening = () => { server.off('error', onError); resolve(p); };
      const onError = (err) => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE' && left > 0) tryPort(p + 1, left - 1);
        else reject(err);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, '127.0.0.1');
    };
    tryPort(port, attempts);
  });
}

async function serve(args) {
  const db = openDb();
  const api = createApi(db);
  const version = codeVersion();
  const token = crypto.randomBytes(24).toString('hex');

  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  /** POST /api/action {action, id}: same-origin only, with the per-start token. */
  function handleAction(req, res, url) {
    const origin = req.headers.origin;
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
    if (req.headers['x-ouroboros-token'] !== token) return sendJson(res, 403, { error: 'bad token' });
    if (origin && origin !== `http://${req.headers.host}`) return sendJson(res, 403, { error: 'bad origin' });
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return sendJson(res, 415, { error: 'JSON only' });
    if (isStale()) return sendJson(res, 503, { error: 'stale', message: 'Ouroboros was updated since this dashboard started. Run /ouroboros:dashboard again to restart it.' });
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 10_000) req.destroy(); });
    req.on('end', async () => {
      try {
        const { action, id } = JSON.parse(body || '{}');
        const result = await runAction(db, action, id, api);
        sendJson(res, result ? 200 : 400, result || { error: `unknown action ${action}` });
      } catch (err) {
        sendJson(res, 500, { error: String(err.message) });
      }
    });
  }
  let lastRequest = Date.now();
  let lastVersionCheck = 0;
  let lastReconcile = 0;
  /** Files deleted outside Ouroboros while the dashboard is open: the page never shows them as learned. */
  const inStep = () => {
    if (Date.now() - lastReconcile < 15_000) return;
    lastReconcile = Date.now();
    try { reconcile(db); } catch (err) { logError(db, 'dashboard:reconcile', err); }
  };
  let port;

  /** True once the code on disk differs from what this process loaded. */
  const isStale = () => {
    if (Date.now() - lastVersionCheck < 3000) return false;
    lastVersionCheck = Date.now();
    return codeVersion() !== version;
  };

  const onRequest = (req, res) => {
    lastRequest = Date.now();
    // No other site may frame the page (a click inside a frame would act as the user).
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', CSP);
    // Reject DNS-rebinding: only our own loopback host names.
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(403).end();
      return;
    }
    // Built from the validated host, so a target like "//" or "/\\" is a path, not a new authority.
    let url;
    try { url = new URL(`http://${host}${req.url}`); } catch { res.writeHead(400).end(); return; }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/action') {
        handleAction(req, res, url);
        return;
      }
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      if (url.pathname === '/api/token') {
        // Readable only by our own origin (no CORS headers); required on every write.
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ token }));
        return;
      }
      if (url.pathname === '/api/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ app: 'ouroboros', version, data: dataDir(), pid: process.pid }));
        return;
      }
      if (isStale()) {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'stale', message: 'Ouroboros was updated since this dashboard started. Run /ouroboros:dashboard again to restart it.' }));
        setTimeout(() => { server.close(); db.close(); process.exit(0); }, 200);
        return;
      }
      try {
        inStep();
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
    let isFile = false;
    try { isFile = file.startsWith(publicDir + path.sep) && fs.statSync(file).isFile(); } catch { /* missing or unreadable */ }
    if (!isFile) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  };

  const server = http.createServer((req, res) => {
    // Nothing a request does may take the server down.
    try { onRequest(req, res); } catch (err) {
      logError(db, 'dashboard:request', err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });

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
