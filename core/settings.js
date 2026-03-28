/**
 * @file data/default-user/extensions/canonize/core/settings.js
 * @stamp {"utc":"2026-03-27T00:00:00.000Z"}
 * @version 1.1.0
 * @architectural-role Re-export Stub
 * @description
 * Backwards-compatibility shim. Settings data layer was moved to
 * `settings/data.js` during the Batch 4 refactor. All existing importers of
 * `core/settings.js` continue to work without changes.
 *
 * @api-declaration
 * Re-exports: getSettings, getMetaSettings, initSettings
 * (See settings/data.js for the canonical implementations.)
 *
 * @contract
 *   assertions:
 *     purity: pure
 *     state_ownership: []
 *     external_io: []
 */

// Moved to settings/data.js — re-exported here for backwards compatibility.
export { getSettings, getMetaSettings, initSettings } from '../settings/data.js';
