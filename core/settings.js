/**
 * @file data/default-user/extensions/canonize/core/settings.js
 * @stamp {"utc":"2025-01-15T12:00:00.000Z"}
 * @architectural-role Re-export Stub
 * @description
 * Backwards-compatibility shim. Settings data layer was moved to
 * `settings/data.js` during the Batch 4 refactor.
 *
 * @api-declaration
 * Re-exports: getSettings, getMetaSettings, initSettings, isExtensionEnabled, setExtensionEnabled
 *
 * @contract
 *   assertions:
 *     purity: pure
 *     state_ownership: []
 *     external_io: []
 */

// Moved to settings/data.js — re-exported here for backwards compatibility.
export { 
    getSettings, 
    getMetaSettings, 
    initSettings, 
    isExtensionEnabled, 
    setExtensionEnabled 
} from '../settings/data.js';