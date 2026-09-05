/**
 * In-app Help: Keyboard Shortcuts, Dialect, and User Guide summary.
 * Opened from Help menu, command palette, and About links.
 */

import {dismissibleModal} from './modal-utils.js';
import {escapeHtml} from './html.js';
import {
    SHORTCUTS,
    DIALECT_RULES,
    QUICKSTART,
    PRIVACY_BLURB,
} from './help-content.js';

export type HelpSection = 'shortcuts' | 'dialect' | 'guide';

class HelpModal {
    private root: HTMLElement | null = null;
    private titleEl: HTMLElement | null = null;
    private bodyEl: HTMLElement | null = null;
    private tabs: HTMLElement | null = null;
    private cleanup: (() => void) | null = null;
    private section: HelpSection = 'guide';
    private inited = false;

    init(): void {
        if (this.inited) return;
        this.root = document.getElementById('helpModal');
        this.titleEl = document.getElementById('helpTitle');
        this.bodyEl = document.getElementById('helpBody');
        this.tabs = document.getElementById('helpTabs');
        if (!this.root) return;

        this.tabs?.addEventListener('click', (e) => {
            const btn = (e.target as Element).closest<HTMLElement>('[data-help-section]');
            if (!btn?.dataset.helpSection) return;
            this.section = btn.dataset.helpSection as HelpSection;
            this.render();
        });

        this.inited = true;
    }

    open(section: HelpSection = 'guide'): void {
        this.init();
        if (!this.root) return;
        this.section = section;
        this.render();
        this.root.hidden = false;
        this.cleanup = dismissibleModal(this.root, () => this.close());
    }

    close(): void {
        if (!this.root) return;
        this.root.hidden = true;
        this.cleanup?.();
        this.cleanup = null;
    }

    private render(): void {
        if (!this.bodyEl || !this.titleEl || !this.tabs) return;

        const titles: Record<HelpSection, string> = {
            shortcuts: 'Keyboard Shortcuts',
            dialect: 'Cycletron Dialect',
            guide: 'User Guide',
        };
        this.titleEl.textContent = titles[this.section];

        for (const btn of this.tabs.querySelectorAll<HTMLElement>('[data-help-section]')) {
            btn.classList.toggle('help-tab--active', btn.dataset.helpSection === this.section);
        }

        if (this.section === 'shortcuts') {
            this.bodyEl.innerHTML = this.renderShortcuts();
        } else if (this.section === 'dialect') {
            this.bodyEl.innerHTML = this.renderDialect();
        } else {
            this.bodyEl.innerHTML = this.renderGuide();
        }
    }

    private renderShortcuts(): string {
        const groups = new Map<string, typeof SHORTCUTS>();
        for (const row of SHORTCUTS) {
            const list = groups.get(row.group) ?? [];
            list.push(row);
            groups.set(row.group, list);
        }
        let html = '<p class="help-lead">App-local shortcuts. Global transport shortcuts are optional in Preferences.</p>';
        for (const [group, rows] of groups) {
            html += `<h4 class="help-h">${escapeHtml(group)}</h4><table class="help-table"><tbody>`;
            for (const r of rows) {
                html += `<tr><td class="help-keys"><kbd>${escapeHtml(r.keys)}</kbd></td><td>${escapeHtml(r.action)}</td></tr>`;
            }
            html += '</tbody></table>';
        }
        return html;
    }

    private renderDialect(): string {
        let html =
            '<p class="help-lead">Cycletron runs <strong>strudel-rs</strong>, not browser Strudel. ' +
            'These are the footguns that cause silence or parse errors most often.</p>';
        for (const rule of DIALECT_RULES) {
            html += `<section class="help-rule">
                <h4 class="help-h">${escapeHtml(rule.title)}</h4>
                <p>${escapeHtml(rule.body)}</p>`;
            if (rule.good) {
                html += `<p class="help-code-label">Do</p><pre class="help-code">${escapeHtml(rule.good)}</pre>`;
            }
            if (rule.bad) {
                html += `<p class="help-code-label help-code-label--bad">Don't</p><pre class="help-code help-code--bad">${escapeHtml(rule.bad)}</pre>`;
            }
            html += '</section>';
        }
        html +=
            '<p class="help-foot">Full surface: <code>docs/STRUDEL_RS_SUPPORTED.md</code> in the repo. ' +
            'Upstream strudel.cc docs are useful for ideas but not dialect truth.</p>';
        return html;
    }

    private renderGuide(): string {
        let html =
            '<p class="help-lead">Live coding on a native Rust engine. Patterns are editable Strudel ' +
            'mini-notation played by strudel-rs in the desktop app.</p>';
        html += '<h4 class="help-h">First 60 seconds</h4><ol class="help-list">';
        for (const step of QUICKSTART) {
            html += `<li>${escapeHtml(step)}</li>`;
        }
        html += '</ol>';
        html +=
            '<h4 class="help-h">Where things live</h4>' +
            '<ul class="help-list">' +
            '<li><strong>Editor</strong> — your pattern. Empty state: Open / New / Examples.</li>' +
            '<li><strong>AI panel</strong> — describe music; the model rewrites the editor.</li>' +
            '<li><strong>Files</strong> — library root for saves and MIDI imports.</li>' +
            '<li><strong>Examples</strong> — Lessons → Patterns → Showcase (Play first, then load).</li>' +
            '<li><strong>Mixer</strong> — mute/solo the <code>$:</code> tracks live. Names come from the comment above each track; your file is never changed.</li>' +
            '</ul>';
        html +=
            '<h4 class="help-h">Performing</h4>' +
            '<p>The <strong>Q</strong> button in the top bar holds each evaluate until the next bar line ' +
            '(click to step through 1/2/4/8 bars) instead of swapping mid-phrase. Mixer moves follow the same grid. ' +
            'Preferences → <strong>OSC Output</strong> streams the transport and note onsets over UDP ' +
            'to Hydra, Resolume, TouchDesigner or a lighting rig.</p>';
        html +=
            '<h4 class="help-h">AI & privacy</h4>' +
            `<p>${escapeHtml(PRIVACY_BLURB)}</p>`;
        html +=
            '<h4 class="help-h">No sound?</h4>' +
            '<p>Press Play once to arm audio, then load Lesson 1. If a pattern is silent after that, open the Dialect tab (pan, voicing, scale).</p>';
        html +=
            '<p class="help-foot">Longer write-up in the repo: <code>docs/USER_GUIDE.md</code>.</p>';
        return html;
    }
}

export const helpModal = new HelpModal();
window.helpModal = helpModal;
