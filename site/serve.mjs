#!/usr/bin/env node
// Serve dist/ locally the way Vercel serves it: clean URLs, and the headers
// from vercel.json (the isolation headers the player needs).

import {createServer} from 'node:http';
import {readFileSync, statSync} from 'node:fs';
import {extname, join, normalize} from 'node:path';

const DIST = join(import.meta.dirname, 'dist');
const PORT = Number(process.env.PORT ?? 4321);
const {headers: rules} = JSON.parse(readFileSync(join(import.meta.dirname, 'vercel.json'), 'utf8'));

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
};

function resolve(pathname) {
    const base = normalize(join(DIST, decodeURIComponent(pathname)));
    if (!base.startsWith(DIST)) return null;
    for (const file of [base, `${base}.html`, join(base, 'index.html')]) {
        try { if (statSync(file).isFile()) return file; } catch { /* next */ }
    }
    return null;
}

createServer((req, res) => {
    const {pathname} = new URL(req.url, 'http://localhost');
    for (const rule of rules) {
        if (new RegExp(`^${rule.source}$`).test(pathname)) {
            for (const {key, value} of rule.headers) res.setHeader(key, value);
        }
    }
    const file = resolve(pathname);
    if (!file) {
        res.writeHead(404, {'Content-Type': 'text/plain'}).end('Not found');
        return;
    }
    res.writeHead(200, {'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream'});
    res.end(readFileSync(file));
}).listen(PORT, () => console.log(`site: http://localhost:${PORT}`));
