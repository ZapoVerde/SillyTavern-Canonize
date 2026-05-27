/**
 * @file data/default-user/extensions/canonize/rag/plugin-health.js
 * @stamp {"utc":"2026-05-25T00:00:00.000Z"}
 * @architectural-role IO Wrapper
 * @description
 * HTTP client for the CNZ plugin health and install-status endpoints. Owns the
 * _pluginReachable runtime flag that gates RAG operations for the page session.
 * Called once at init by the plugin-setup orchestrator; result persists until reload.
 *
 * @api-declaration
 * checkPluginHealth()     → Promise<{ reachable, needsSymlink, extensionFound, canWrite, isDocker }>
 * requestInstallSymlink() → Promise<void>   (throws on server error)
 * isPluginReachable()     → boolean
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [_pluginReachable]
 *     external_io:     [/api/plugins/cnz/inspect, /api/plugins/cnz/install-status,
 *                       /api/plugins/cnz/install-symlink]
 */

import { getRequestHeaders } from '../../../../../script.js';

const BASE = '/api/plugins/cnz';

let _pluginReachable = true;  // optimistic until first check
let _lastResult      = null;  // cached result of most recent checkPluginHealth()

export function isPluginReachable() { return _pluginReachable; }
export function getLastHealthResult() { return _lastResult; }

export async function checkPluginHealth() {
    try {
        const res = await fetch(`${BASE}/inspect`, { headers: getRequestHeaders() });
        if (!res.ok) {
            _pluginReachable = false;
            return (_lastResult = { reachable: false, needsSymlink: false, extensionFound: false, canWrite: false, isDocker: false });
        }
        _pluginReachable = true;
    } catch {
        _pluginReachable = false;
        return (_lastResult = { reachable: false, needsSymlink: false, extensionFound: false, canWrite: false, isDocker: false });
    }

    try {
        const res  = await fetch(`${BASE}/install-status`, { headers: getRequestHeaders() });
        const data = res.ok ? await res.json() : {};
        return (_lastResult = {
            reachable:      true,
            needsSymlink:   data.needsSymlink   ?? false,
            extensionFound: data.extensionFound ?? false,
            canWrite:       data.canWrite        ?? false,
            isDocker:       data.isDocker        ?? false,
        });
    } catch {
        return (_lastResult = { reachable: true, needsSymlink: false, extensionFound: false, canWrite: false, isDocker: false });
    }
}

export async function requestInstallSymlink() {
    const res = await fetch(`${BASE}/install-symlink`, {
        method:  'POST',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        body:    JSON.stringify({}),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? res.statusText);
    }
}
