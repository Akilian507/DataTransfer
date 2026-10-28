const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

const PORT = Number(process.env.PORT) || 3000;
const MAX_SIZE = 2 * 1024 ** 3;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(ROOT, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function safeName(raw) {
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    name = String(raw);
  }
  name = path.basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  if (!name || name === '.' || name === '..') name = 'datei';
  return name.slice(0, 200);
}

function uniqueName(name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = name;
  let i = 1;
  while (fs.existsSync(path.join(UPLOAD_DIR, candidate))) {
    candidate = `${stem} (${i})${ext}`;
    i++;
  }
  return candidate;
}

function listFiles() {
  return fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.includes('.part-'))
    .map((entry) => {
      const stat = fs.statSync(path.join(UPLOAD_DIR, entry.name));
      return { name: entry.name, size: stat.size, modified: stat.mtimeMs };
    })
    .sort((a, b) => b.modified - a.modified);
}

async function handleUpload(req, res) {
  const headerName = req.headers['x-filename'];
  if (!headerName) {
    return json(res, 400, { error: 'Dateiname fehlt (Header X-Filename).' });
  }

  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_SIZE) {
    return json(res, 413, { error: 'Datei ist zu groß (max. 2 GB).' });
  }

  const name = uniqueName(safeName(headerName));
  const target = path.join(UPLOAD_DIR, name);
  const tmp = `${target}.part-${Date.now()}`;

  let received = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (received > MAX_SIZE) {
        return cb(Object.assign(new Error('too large'), { code: 'TOO_LARGE' }));
      }
      cb(null, chunk);
    }
  });

  try {
    await pipeline(req, limiter, fs.createWriteStream(tmp));
    fs.renameSync(tmp, target);
    const stat = fs.statSync(target);
    json(res, 201, { name, size: stat.size });
  } catch (err) {
    fs.rm(tmp, { force: true }, () => {});
    if (err.code === 'TOO_LARGE') {
      return json(res, 413, { error: 'Datei ist zu groß (max. 2 GB).' });
    }
    console.error('Upload fehlgeschlagen:', err.message);
    json(res, 500, { error: 'Upload fehlgeschlagen.' });
  }
}

async function handleDownload(res, rawName) {
  const name = safeName(rawName);
  const filePath = path.join(UPLOAD_DIR, name);
  if (!filePath.startsWith(UPLOAD_DIR + path.sep)) {
    return json(res, 400, { error: 'Ungültiger Dateiname.' });
  }

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return json(res, 404, { error: 'Datei nicht gefunden.' });
  }
  if (!stat.isFile()) {
    return json(res, 404, { error: 'Datei nicht gefunden.' });
  }

  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`
  });
  fs.createReadStream(filePath).pipe(res);
}

async function handleDelete(res, rawName) {
  const name = safeName(rawName);
  const filePath = path.join(UPLOAD_DIR, name);
  if (!filePath.startsWith(UPLOAD_DIR + path.sep)) {
    return json(res, 400, { error: 'Ungültiger Dateiname.' });
  }
  try {
    await fs.promises.unlink(filePath);
    json(res, 200, { deleted: name });
  } catch {
    json(res, 404, { error: 'Datei nicht gefunden.' });
  }
}

function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return json(res, 404, { error: 'Nicht gefunden.' });
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      return json(res, 404, { error: 'Nicht gefunden.' });
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  try {
    if (req.method === 'GET' && pathname === '/api/files') {
      return json(res, 200, listFiles());
    }
    if (req.method === 'POST' && pathname === '/api/upload') {
      return await handleUpload(req, res);
    }
    if (req.method === 'GET' && pathname.startsWith('/download/')) {
      return await handleDownload(res, pathname.slice('/download/'.length));
    }
    if (req.method === 'DELETE' && pathname.startsWith('/api/files/')) {
      return await handleDelete(res, pathname.slice('/api/files/'.length));
    }
    if (req.method === 'GET') {
      return serveStatic(res, pathname);
    }
    json(res, 405, { error: 'Methode nicht erlaubt.' });
  } catch (err) {
    console.error('Serverfehler:', err);
    if (!res.headersSent) {
      json(res, 500, { error: 'Serverfehler.' });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Datei-Teiler läuft auf:`);
  console.log(`  http://localhost:${PORT}`);
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  http://${net.address}:${PORT}  (im selben Netzwerk)`);
      }
    }
  }
});
