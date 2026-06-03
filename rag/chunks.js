/**
 * @file data/default-user/extensions/canonize/rag/chunks.js
 * @stamp {"utc":"2026-05-21T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role Pure Functions
 * @description
 * Pure RAG derivation: building the chunk state array from prose pairs and
 * assembling the final RAG document string from the classified chunk state.
 * No state reads, no IO. Callers supply all inputs explicitly.
 *
 * @api-declaration
 * buildRagChunks(pairs, pairOffset, settings)
 * buildRagDocument(ragChunks, settings, charName)
 *
 * @contract
 *   assertions:
 *     purity: pure
 *     state_ownership: [none]
 *     external_io: [none]
 */

import { formatPairsAsTranscript } from '../core/transcript.js';
import { interpolate } from '../defaults.js';

const DEFAULT_SEPARATOR = 'Chunk {{chunk_number}} ({{turn_range}})';

/**
 * Builds the final RAG document from the workshop chunk state.
 * Each chunk is prefixed with the separator template (default '***').
 * ragContents controls whether summary header, full content, or both are emitted.
 * Pure function — all inputs passed explicitly.
 * @param {Array}  ragChunks
 * @param {object} settings   Active profile settings (ragContents, ragSeparator).
 * @param {string} charName   Character name for separator interpolation.
 * @returns {string}
 */
export function buildRagDocument(ragChunks, settings, charName) {
    if (!ragChunks.length) return '';
    const contents    = settings.ragContents    ?? 'summary+full';
    const sepTemplate = settings.ragSeparator?.trim() || DEFAULT_SEPARATOR;

    const body = ragChunks.map(c => {
        const sep = interpolate(sepTemplate, {
            chunk_number: String(c.chunkIndex + 1),
            turn_number:  String(c.chunkIndex + 1),   // backward-compat alias
            turn_range:   c.turnRange,
            char_name:    charName,
        });
        const parts = [sep];
        if (contents !== 'full')    parts.push(c.header);   // summary
        if (contents !== 'summary') parts.push(c.content);  // full content
        return parts.filter(Boolean).join('\n\n');
    }).join('\n\n***\n\n').trim();
    return `[Narrative Memory]\n\n${body}`;
}

/**
 * Builds the state._ragChunks state array from the staged prose pairs.
 * Sliding ragChunkSize-pair windows; headers classified by AI on first sync.
 * Pure function — all inputs passed explicitly.
 * @param {Array}  pairs
 * @param {number} [pairOffset=0]
 * @param {object} settings  Active profile settings (ragChunkSize, ragChunkOverlap).
 * @returns {Array}
 */
export function buildRagChunks(pairs, pairOffset = 0, settings) {
    // Exclude user-only pairs (no AI response yet) — they produce empty RAG chunks
    // that confuse the classifier with a stimulus and no reply.
    pairs = pairs.filter(p => p.messages.length > 0);
    const chunks    = [];
    const chunkSize = Math.max(1, settings.ragChunkSize ?? 2);
    const overlap   = Math.max(0, settings.ragChunkOverlap ?? 0);

    if (overlap === 0) {
        // Non-overlapping: advance by chunkSize each step
        for (let i = 0; i < pairs.length; i += chunkSize) {
            const window    = pairs.slice(i, i + chunkSize);
            const turnA     = pairOffset + i + 1;
            const turnB     = pairOffset + Math.min(i + chunkSize, pairs.length);
            const turnRange = turnA === turnB ? `Turn ${turnA}` : `Turns ${turnA}–${turnB}`;

            chunks.push({
                chunkIndex: chunks.length,
                pairStart:  i,
                pairEnd:    Math.min(i + chunkSize, pairs.length),
                turnRange,
                content:    formatPairsAsTranscript(window),
                header:     turnRange,
                status:     'pending',
            });
        }
    } else {
        // Overlapping: step = 1 new pair per chunk; each chunk includes `overlap` prior pairs
        for (let i = 0; i < pairs.length; i++) {
            const sliceFrom = Math.max(0, i - overlap);
            const window    = pairs.slice(sliceFrom, i + 1);
            const turnA     = pairOffset + sliceFrom + 1;
            const turnB     = pairOffset + i + 1;
            const turnRange = turnA === turnB ? `Turn ${turnA}` : `Turns ${turnA}–${turnB}`;

            const content = formatPairsAsTranscript(window);

            chunks.push({
                chunkIndex: chunks.length,
                pairStart:  sliceFrom,
                pairEnd:    i + 1,
                turnRange,
                content,
                header:  turnRange,
                status:  'pending',
            });
        }
    }
    return chunks;
}
