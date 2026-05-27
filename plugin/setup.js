/**
 * @file plugins/cnz/setup.js
 * @stamp {"utc":"2026-05-25T00:00:00.000Z"}
 * @architectural-role IO Wrapper — filesystem install-status check and symlink creation
 * @description
 * Determines whether the deployed plugin directory is a symlink pointing to the
 * Canonize extension's plugin/ subdirectory, and replaces it with one on request.
 *
 * On creation: node_modules are migrated from the deployed dir to the extension
 * plugin dir first so the symlink target is immediately usable on next restart.
 * The original dir is held as a timestamped backup and deleted on success;
 * restored on any failure so the plugin remains in a known-good state.
 *
 * @api-declaration
 * getInstallStatus() → { needsSymlink: boolean, extensionFound: boolean, canWrite: boolean, isDocker: boolean }
 * installSymlink()   → Promise<void>   (throws on failure)
 *
 * @contract
 *   assertions:
 *     purity:          mutates (filesystem)
 *     state_ownership: [none]
 *     external_io:     [filesystem]
 */

import path              from 'path';
import fs                from 'fs';
import { fileURLToPath } from 'url';

const __filename     = fileURLToPath(import.meta.url);
const __dirname_here = path.dirname(__filename);   // [ST_ROOT]/plugins/cnz

const PLUGIN_DIR     = __dirname_here;
const ST_ROOT        = path.resolve(__dirname_here, '../..');
const EXT_PLUGIN_DIR = path.join(
    ST_ROOT, 'public', 'scripts', 'extensions', 'third-party', 'SillyTavern-Canonize', 'plugin',
);

export function getInstallStatus() {
    const isDocker = fs.existsSync('/.dockerenv');

    let needsSymlink = false;
    try {
        needsSymlink = !fs.lstatSync(PLUGIN_DIR).isSymbolicLink();
    } catch {
        return { needsSymlink: false, extensionFound: false, canWrite: false, isDocker };
    }

    const extensionFound = fs.existsSync(EXT_PLUGIN_DIR);

    let canWrite = false;
    try {
        fs.accessSync(path.dirname(PLUGIN_DIR), fs.constants.W_OK);
        canWrite = true;
    } catch { /* read-only mount or wrong owner */ }

    return { needsSymlink, extensionFound, canWrite, isDocker };
}

export async function installSymlink() {
    if (!fs.existsSync(EXT_PLUGIN_DIR)) {
        throw new Error(`Extension plugin directory not found: ${EXT_PLUGIN_DIR}`);
    }

    // Migrate node_modules to the extension dir so the symlink target works immediately.
    const srcMods = path.join(PLUGIN_DIR, 'node_modules');
    const dstMods = path.join(EXT_PLUGIN_DIR, 'node_modules');
    if (fs.existsSync(srcMods) && !fs.existsSync(dstMods)) {
        fs.renameSync(srcMods, dstMods);
    }

    const backup    = path.join(path.dirname(PLUGIN_DIR), `cnz_bak_${Date.now()}`);
    const relTarget = path.relative(path.dirname(PLUGIN_DIR), EXT_PLUGIN_DIR);

    fs.renameSync(PLUGIN_DIR, backup);
    try {
        fs.symlinkSync(relTarget, PLUGIN_DIR, 'dir');
        fs.rmSync(backup, { recursive: true, force: true });
    } catch (err) {
        fs.renameSync(backup, PLUGIN_DIR); // rollback
        throw err;
    }
}
