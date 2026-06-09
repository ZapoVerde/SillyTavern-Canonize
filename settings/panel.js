/**
 * @file data/default-user/extensions/canonize/settings/panel.js
 * @stamp {"utc":"2026-06-03T21:26:00.000Z"}
 * @version 2.0.1
 * @architectural-role Orchestrator
 * @description
 * Owns the extension settings panel rendered in the ST extensions drawer.
 * Delegates HTML construction to settings-html.js; delegates handler binding
 * to handlers-rag.js and handlers-core.js. Keeps: prompt-editor modal,
 * dirty-state tracking, UI refresh, profile dropdown rebuild, Connection
 * Manager dropdown init, and panel injection.
 *
 * @api-declaration
 *   injectSettingsPanel
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [extension_settings.cnz (via getSettings/getMetaSettings)]
 *     external_io: [DOM, saveSettingsDebounced]
 */

import { saveSettingsDebounced } from '../../../../../script.js';
import { ConnectionManagerRequestService } from '../../../shared.js';
import { buildSettingsHTML } from './settings-html.js';
import { escapeHtml } from '../state.js';
import { getSettings, getMetaSettings } from './data.js';
import { log, warn, setVerbose } from '../log.js';
import { bindRagHandlers } from './handlers-rag.js';
import { configureFts } from '../rag/fts.js';
import { bindPlotHandlers } from './handlers-plot.js';
import { bindCoreHandlers } from './handlers-core.js';
import { bindAdditionalLbHandlers, refreshAdditionalLbList } from './handlers-additional-lb.js';

// ── Prompt Modal ──────────────────────────────────────────────────────────────

/**
 * Opens the prompt-editor popup for a given settings key.
 * @param {string}   settingsKey   Key in activeState to read/write.
 * @param {string}   title         Title shown in the modal header.
 * @param {string}   defaultValue  Value restored by "Reset to Default".
 * @param {string[]} vars          Template variable names shown as badges.
 */
function openPromptModal(settingsKey, title, defaultValue, vars = []) {
    const $overlay  = $('#cnz-pm-overlay');
    const $textarea = $('#cnz-pm-textarea');
    const $titleEl  = $('#cnz-pm-title');
    const $reset    = $('#cnz-pm-reset');
    const $close    = $('#cnz-pm-close');
    const $vars     = $('#cnz-pm-vars');

    $titleEl.text(title);
    $textarea.val(getSettings()[settingsKey] ?? defaultValue);
    $vars.html(vars.map(v => `<code class="cnz-pm-var">{{${v}}}</code>`).join(' '));

    $textarea.off('input.pm');
    $reset.off('click.pm');
    $close.off('click.pm');
    $overlay.off('mousedown.pm click.pm');
    $('#cnz-pm-modal').off('mousedown.pm click.pm').on('mousedown.pm click.pm', e => e.stopPropagation());

    $textarea.on('input.pm', function () {
        getSettings()[settingsKey] = $(this).val();
        saveSettingsDebounced(); updateDirtyIndicator();
    });
    $reset.on('click.pm', function () {
        getSettings()[settingsKey] = defaultValue;
        $textarea.val(defaultValue);
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    const closePromptModal = (e) => { e?.stopPropagation(); $overlay.addClass('cnz-hidden'); };
    $close.on('click.pm', closePromptModal);
    $overlay.on('click.pm', function (e) {
        if (e.target === this) closePromptModal(e);
    }).on('mousedown.pm', function (e) {
        if (e.target === this) e.stopPropagation();
    });

    $overlay.removeClass('cnz-hidden');
    requestAnimationFrame(() => $textarea[0]?.focus());
}

// ── Settings Panel ────────────────────────────────────────────────────────────

function isStateDirty() {
    const meta = getMetaSettings();
    return JSON.stringify(meta.activeState) !== JSON.stringify(meta.profiles[meta.currentProfileName]);
}

function updateDirtyIndicator() {
    const meta  = getMetaSettings();
    const label = meta.currentProfileName + (isStateDirty() ? ' *' : '');
    const $sel  = $('#cnz-profile-select');
    $sel.find(`option[value="${CSS.escape(meta.currentProfileName)}"]`).text(label);
    $sel.val(meta.currentProfileName);
}

/**
 * Repopulates all settings inputs from activeState. Called after loading a profile.
 */
function refreshSettingsUI() {
    const s = getSettings();

    $('#cnz-set-live-context-buffer').val(s.liveContextBuffer ?? 5);
    $('#cnz-set-chunk-every-n').val(s.chunkEveryN ?? 20);
    $('#cnz-set-hookseeker-horizon').val(s.hookseekerHorizon ?? 40);
    $('#cnz-set-lorebook-sync-start').val(s.lorebookSyncStart ?? 'syncPoint');

    $('#cnz-set-rag-max-tokens').val(s.ragMaxTokens ?? 100);
    $('#cnz-set-rag-chunk-size').val(s.ragChunkSize ?? 2);
    $('#cnz-set-rag-classifier-history').val(s.ragClassifierHistory ?? 0);
    $('#cnz-set-rag-max-concurrent').val(s.maxConcurrentCalls ?? 3);
    $('#cnz-set-rag-retries').val(s.ragMaxRetries ?? 1);

    $('#cnz-set-embedding-source').val(s.ragEmbeddingSource ?? 'openrouter');
    $('#cnz-set-embedding-model').val(s.ragEmbeddingModel ?? '');
    $('#cnz-set-rag-cutoff-mode').val(s.ragCutoffMode ?? 'mean');
    $('#cnz-set-rag-pool-multiple').val(s.ragPoolMultiple ?? 2);
    $('#cnz-set-rag-pool-multiple-val').text((s.ragPoolMultiple ?? 2) + 'x');
    $('#cnz-set-rag-kw-blend').val(s.ragKwBlend ?? 0.7);
    $('#cnz-set-rag-kw-blend-val').text(Math.round((s.ragKwBlend ?? 0.7) * 100) + '% vec');
    $('#cnz-set-rag-chat-min').val(s.ragChatMin ?? 2);
    $('#cnz-set-rag-chat-max').val(s.ragChatMax ?? 8);
    $('#cnz-set-rag-lb-min').val(s.ragLbMin ?? 2);
    $('#cnz-set-rag-lb-max').val(s.ragLbMax ?? 4);
    $('#cnz-set-rag-separator').val(s.ragSeparator ?? '%%%');
    $('#cnz-set-rag-fts-unicode').prop('checked', s.ragFtsUnicode ?? false);
    configureFts({ unicodeMode: s.ragFtsUnicode ?? false });

    $('#cnz-set-plot-retrieval-topk').val(s.ragPlotRetrievalTopK ?? 3);
    $('#cnz-set-plot-recency-count').val(s.ragPlotRecencyCount ?? 3);
    $('#cnz-set-plot-min-arcs').val(s.ragPlotMinArcs ?? 2);
    $('#cnz-set-plot-filler-enabled').prop('checked', s.ragPlotFillerEnabled ?? true);
    $('#cnz-set-plot-filler-cards').val(s.ragPlotFillerCards ?? 1);
    $('#cnz-set-plot-filler-strategy').val(s.ragPlotFillerStrategy ?? 'random');
    $('#cnz-plot-filler-body').toggleClass('cnz-disabled', !(s.ragPlotFillerEnabled ?? true));

    try {
        ConnectionManagerRequestService.handleDropdown(
            '#cnz-set-profile', s.profileId ?? '',
            (profile) => { getSettings().profileId = profile?.id ?? null; saveSettingsDebounced(); updateDirtyIndicator(); },
        );
    } catch (e) { /* silent */ }
    try {
        ConnectionManagerRequestService.handleDropdown(
            '#cnz-set-rag-profile', s.ragProfileId ?? '',
            (profile) => { getSettings().ragProfileId = profile?.id ?? null; saveSettingsDebounced(); updateDirtyIndicator(); },
        );
    } catch (e) { /* silent */ }

    $('#cnz-set-verbose-logging').prop('checked', getMetaSettings().verboseLogging ?? false);
    updateDirtyIndicator();
}

function refreshProfileDropdown() {
    const meta = getMetaSettings();
    const $sel = $('#cnz-profile-select');
    $sel.empty();
    for (const name of Object.keys(meta.profiles)) {
        $sel.append($('<option>').val(name).text(name));
    }
    updateDirtyIndicator();
}

function bindSettingsHandlers() {
    bindRagHandlers({ updateDirtyIndicator, openPromptModal });
    bindPlotHandlers({ updateDirtyIndicator, openPromptModal });
    bindCoreHandlers({ updateDirtyIndicator, openPromptModal, refreshProfileDropdown, refreshSettingsUI });
    bindAdditionalLbHandlers();
    refreshAdditionalLbList();

    try {
        ConnectionManagerRequestService.handleDropdown(
            '#cnz-set-profile', getSettings().profileId ?? '',
            (profile) => { getSettings().profileId = profile?.id ?? null; saveSettingsDebounced(); updateDirtyIndicator(); },
        );
    } catch (e) { warn('Settings', 'Could not initialize profile dropdown:', e); }

    try {
        ConnectionManagerRequestService.handleDropdown(
            '#cnz-set-rag-profile', getSettings().ragProfileId ?? '',
            (profile) => { getSettings().ragProfileId = profile?.id ?? null; saveSettingsDebounced(); updateDirtyIndicator(); },
        );
    } catch (e) { warn('Settings', 'Could not initialize RAG profile dropdown:', e); }
}

export function injectSettingsPanel() {
    log('Init', 'injectSettingsPanel: Checking for #extensions_settings...');
    if ($('#cnz-settings').length) return;
    const $parent = $('#extensions_settings');
    if ($parent.length === 0) { warn('Init', 'injectSettingsPanel: #extensions_settings not found in DOM!'); return; }
    const meta         = getMetaSettings();
    $parent.append(
        buildSettingsHTML(getSettings(), escapeHtml, Object.keys(meta.profiles), meta.currentProfileName, meta.verboseLogging ?? false, meta.enableCnz ?? true),
    );
    setVerbose(meta.verboseLogging ?? false);
    bindSettingsHandlers();
    refreshProfileDropdown();
    log('Init', 'injectSettingsPanel: Success.');
}