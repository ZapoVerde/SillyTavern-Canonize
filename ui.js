/**
 * @file data/default-user/extensions/canonize/ui.js
 * @stamp {"utc":"2025-01-15T12:00:00.000Z"}
 * @architectural-role Re-export Stub
 * @description
 * Aggregates and re-exports HTML factory functions from specialized 
 * UI sub-modules. Ensures the rest of the extension can import all 
 * templates from a single entry point.
 *
 * @api-declaration
 * buildModalHTML, buildPromptModalHTML, buildSettingsHTML, 
 * buildOrphanModalHTML, buildDnaChainInspectorHTML
 *
 * @contract
 *   assertions:
 *     purity: pure
 *     state_ownership: []
 *     external_io: none
 */

export { buildModalHTML } from './ui/wizard-html.js';

export { buildSettingsHTML } from './ui/settings-html.js';

export { 
    buildPromptModalHTML, 
    buildOrphanModalHTML, 
    buildDnaChainInspectorHTML 
} from './ui/common-modals-html.js';