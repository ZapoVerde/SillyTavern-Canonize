/**
 * @file data/default-user/extensions/canonize/settings/handlers-plot.js
 * @stamp {"utc":"2026-05-29T00:00:00.000Z"}
 * @architectural-role IO Wrapper
 * @description
 * Binds all Plot Management settings panel event handlers.
 *
 * @api-declaration
 * bindPlotHandlers({ updateDirtyIndicator })
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [extension_settings.cnz (via getSettings)]
 *     external_io: [DOM, saveSettingsDebounced]
 */

import { saveSettingsDebounced } from '../../../../../script.js';
import { getSettings } from './data.js';

export function bindPlotHandlers({ updateDirtyIndicator }) {

    $('#cnz-set-plot-retrieval-topk').on('input', function () {
        getSettings().ragPlotRetrievalTopK = Math.max(0, parseInt($(this).val()) || 3);
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-plot-recency-count').on('input', function () {
        getSettings().ragPlotRecencyCount = Math.max(1, parseInt($(this).val()) || 3);
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-plot-min-arcs').on('input', function () {
        getSettings().ragPlotMinArcs = Math.max(0, parseInt($(this).val()) || 2);
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-plot-filler-enabled').on('change', function () {
        getSettings().ragPlotFillerEnabled = $(this).prop('checked');
        saveSettingsDebounced(); updateDirtyIndicator();
        $('#cnz-plot-filler-body').toggleClass('cnz-disabled', !getSettings().ragPlotFillerEnabled);
    });

    $('#cnz-set-plot-filler-cards').on('input', function () {
        getSettings().ragPlotFillerCards = Math.max(1, parseInt($(this).val()) || 1);
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-plot-filler-strategy').on('change', function () {
        getSettings().ragPlotFillerStrategy = $(this).val();
        saveSettingsDebounced(); updateDirtyIndicator();
    });
}
