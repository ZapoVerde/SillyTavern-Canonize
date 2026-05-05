/**
 * @file data/default-user/extensions/canonize/utils/mobile-debug.js
 * @stamp {"utc":"2026-03-27T00:00:00.000Z"}
 * @architectural-role UI / Debug Utility
 * @description
 * Provides an on-screen console overlay for mobile debugging by hijacking 
 * console.log, console.warn, and console.error. This allows developers to 
 * view logs directly on devices without easy access to remote debugging.
 *
 * @api-declaration
 * initMobileDebug()
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [console, DOM]
 */

import { enableDevMode } from '../bus.js';

/**
 * Injects a scrollable console overlay at the bottom of the screen and 
 * redirects standard console methods to print to this overlay.
 * Also enables the bus developer mode for event logging.
 */
export function initMobileDebug() {
    const panel = document.createElement('div');
    panel.id = 'cnz-debug-panel';
    panel.style.cssText = [
        'position:fixed', 'bottom:0', 'left:0', 'right:0', 'z-index:999999',
        'background:#111', 'color:#0f0', 'font:11px monospace',
        'max-height:40vh', 'overflow-y:auto', 'padding:4px',
        'border-top:2px solid #0f0',
        'pointer-events: none'
    ].join(';');
    
    // Ensure injection even if DOM is still loading
    if (document.body) {
        document.body.appendChild(panel);
    } else {
        document.addEventListener('DOMContentLoaded', () => document.body.appendChild(panel));
    }

    const orig = { 
        log: console.log.bind(console), 
        warn: console.warn.bind(console), 
        error: console.error.bind(console) 
    };

    ['log', 'warn', 'error'].forEach(level => {
        console[level] = function(...args) {
            orig[level](...args);
            const line = document.createElement('div');
            line.style.cssText = 'border-bottom: 1px solid #222; padding: 2px 0;';
            line.style.color = level === 'error' ? '#f44' : level === 'warn' ? '#fa0' : '#0f0';
            
            line.textContent = `[${level}] ${args.map(a => {
                try { 
                    return typeof a === 'object' ? JSON.stringify(a) : String(a); 
                } catch (err) { 
                    return String(a); 
                }
            }).join(' ')}`;
            
            panel.appendChild(line);
            panel.scrollTop = panel.scrollHeight;
        };
    });

    enableDevMode();
}