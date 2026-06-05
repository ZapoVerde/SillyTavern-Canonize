/**
 * @file data/default-user/extensions/canonize/rag/file-io.js
 * @stamp {"utc":"2026-06-04T00:00:00.000Z"}
 * @architectural-role IO Wrapper — user file read/write via ST's file endpoints
 * @description
 * Thin wrappers around ST's /user/files/* (read) and /api/files/upload (write)
 * endpoints. Imported by file-store.js, file-store-lb.js, and chat-store.js.
 *
 * @api-declaration
 * readFile(name)        → Promise<object|null>
 * writeFile(name, obj)  → Promise<void>
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [none]
 *     external_io:     [GET /user/files/*, POST /api/files/upload]
 */

import { getRequestHeaders } from '../../../../../script.js';

function _encode(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    const parts = [];
    for (let i = 0; i < bytes.length; i += 0x8000)
        parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
    return btoa(parts.join(''));
}

export async function readFile(name) {
    const res = await fetch(`/user/files/${name}`, { headers: getRequestHeaders() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`CNZ file-io read ${name}: ${res.statusText}`);
    return res.json();
}

export async function writeFile(name, obj) {
    const res = await fetch('/api/files/upload', {
        method:  'POST',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name, data: _encode(obj) }),
    });
    if (!res.ok) throw new Error(`CNZ file-io write ${name}: ${res.statusText}`);
}

export async function readRawFile(name) {
    const res = await fetch(`/user/files/${name}`, { headers: getRequestHeaders() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`CNZ file-io read ${name}: ${res.statusText}`);
    return res.text();
}

export async function writeRawFile(name, text) {
    const bytes = new TextEncoder().encode(text);
    const parts = [];
    for (let i = 0; i < bytes.length; i += 0x8000)
        parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
    const res = await fetch('/api/files/upload', {
        method:  'POST',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name, data: btoa(parts.join('')) }),
    });
    if (!res.ok) throw new Error(`CNZ file-io write ${name}: ${res.statusText}`);
}
