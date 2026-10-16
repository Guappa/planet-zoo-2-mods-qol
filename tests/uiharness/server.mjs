// Tiny static server for the PZ2 UI harness.
//
// Serves a *virtual* merged web root: each request is looked up in the
// overlay roots first (the mod's UI/UIGameface), then in the game's unpacked
// UIGameface. Nothing is copied or modified on disk.
//
//   node server.mjs --game <UIGameface> --overlay <mod UIGameface> [--port 8123]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.dds': 'application/octet-stream',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.webm': 'video/webm',
    '.mp4': 'video/mp4',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
};

function resolveFile(roots, urlPath) {
    let rel;
    try {
        rel = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
    }
    catch {
        return null;
    }
    rel = rel.replace(/^\/+/, '');
    if (rel === '') rel = 'index.html';
    for (const root of roots) {
        const abs = path.resolve(root, rel);
        if (!abs.startsWith(path.resolve(root))) continue; // no traversal
        try {
            const st = fs.statSync(abs);
            if (st.isFile()) return abs;
        }
        catch { /* try next root */ }
    }
    // Gameface resolves paths case-insensitively on Windows; so does NTFS, so
    // a plain stat already covers that.
    return null;
}

export function startServer({ roots, port = 0, log404 = null }) {
    const misses = [];
    const server = http.createServer((req, res) => {
        const file = resolveFile(roots, req.url);
        if (!file) {
            misses.push(req.url);
            if (log404) log404(req.url);
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end();
            return;
        }
        const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
            const actual = server.address().port;
            resolve({ server, port: actual, url: `http://127.0.0.1:${actual}`, misses });
        });
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
    const roots = [];
    for (let i = 0; i < args.length; i++) if (args[i] === '--overlay') roots.push(args[i + 1]);
    roots.push(get('--game'));
    const { url } = await startServer({ roots, port: Number(get('--port', 8123)), log404: u => console.log('404', u) });
    console.log(`Serving ${roots.join(' + ')} at ${url}`);
}
