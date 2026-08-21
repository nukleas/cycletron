/**
 * Sounds panel — surfaces what's actually playable right now: the built-in
 * synths, the default drum banks, common General MIDI instruments (which stream
 * in on first use), and any sample banks the user has loaded from disk. Backed
 * by the `list_sounds` command so it always reflects reality. Click a chip to
 * insert a starter snippet at the editor cursor.
 */

import {invoke, isTauri} from './tauri.js';
import {escapeHtml} from './html.js';
import {samplesModal} from './samples-modal.js';


interface DrumMachine {
    machine: string;
    display: string;
    banks: string[];
}

/**
 * Two shapes, depending on the active sample set (Samples manager):
 * the bundled set fills drums/percussion/instruments/drum_machines; a
 * downloaded set replaces those with `sample_set_banks` (+ its id).
 */
interface SoundCatalog {
    synths: string[];
    wavetables: string[];
    drums?: string[];
    percussion?: string[];
    instruments?: string[];
    drum_machines?: DrumMachine[];
    active_sample_set?: string;
    /** Note-mapped banks — note(…) repitches properly. */
    sample_set_pitched?: string[];
    /** Indexed one-shots — note(…) rate-repitches from a C3 root; :n variants. */
    sample_set_one_shots?: string[];
    gm_instruments: string[];
    gm_note?: string;
    user_sample_banks: string[];
}

type SoundKind = 'synth' | 'drum' | 'gm' | 'machine' | 'sample';

export class SoundsBrowser {
    private listEl: HTMLElement | null = null;
    private countEl: HTMLElement | null = null;

    async init(): Promise<void> {
        this.listEl = document.getElementById('soundsList');
        this.countEl = document.getElementById('soundsCount');
        if (!this.listEl) return;

        this.listEl.addEventListener('click', (e) => {
            const chip = (e.target as Element).closest('.sound-chip') as HTMLElement | null;
            if (!chip) return;
            this.insert(chip.dataset.name ?? '', (chip.dataset.kind as SoundKind) ?? 'sample');
        });

        // The user loading a sample folder adds banks — refresh when notified.
        document.addEventListener('sounds:changed', () => void this.refresh());
        document.getElementById('soundsManage')?.addEventListener('click', () => {
            void samplesModal.open();
        });

        await this.refresh();
    }

    async refresh(): Promise<void> {
        if (!this.listEl) return;
        if (!isTauri) {
            this.listEl.innerHTML = '<div class="sounds-empty">Sounds available in the desktop build.</div>';
            return;
        }
        try {
            const cat = await invoke<SoundCatalog>('list_sounds');
            this.render(cat);
        } catch (e) {
            this.listEl.innerHTML = `<div class="sounds-empty">${escapeHtml(String(e))}</div>`;
        }
    }

    private render(cat: SoundCatalog): void {
        if (!this.listEl) return;
        const setPitched = cat.sample_set_pitched ?? [];
        const setOneShots = cat.sample_set_one_shots ?? [];
        const total =
            cat.synths.length + (cat.drums?.length ?? 0) + (cat.percussion?.length ?? 0) +
            (cat.instruments?.length ?? 0) + setPitched.length + setOneShots.length +
            cat.gm_instruments.length + cat.user_sample_banks.length;
        if (this.countEl) this.countEl.textContent = String(total);

        // Bundled-set groups (absent when a downloaded sample set is active).
        const bundledGroups = [
            cat.drums?.length ? this.group('Drums', cat.drums, 'drum') : '',
            cat.percussion?.length ? this.group('Percussion & Textures', cat.percussion, 'sample', 'perc/metal/east/hand/industrial · space/arpy · tabla/jvbass') : '',
            cat.instruments?.length ? this.group('Melodic & Speech', cat.instruments, 'sample', 'flbass/uke/cpluck/cbow · speech · s("flbass:2") for variants') : '',
            // Drum machines: one collapsible group per machine
            ...(cat.drum_machines ?? []).map(m => this.group(m.display, m.banks, 'machine')),
        ];

        // Downloaded-set groups, split by how note(…) behaves on them.
        const setName = cat.active_sample_set ?? '';
        const setGroups = [
            setPitched.length
                ? this.group(`${setName}: Pitched`, setPitched, 'gm', 'note-mapped — note(…) repitches')
                : '',
            setOneShots.length
                ? this.group(
                    `${setName}: One-shots`,
                    setOneShots,
                    'sample',
                    'note(…) repitches from C3 root · :n for variants · load on first use',
                )
                : '',
        ];

        this.listEl.innerHTML = [
            this.group('Synths', cat.synths, 'synth'),
            this.group('Wavetables', cat.wavetables ?? [], 'synth', 'use with note(…).s("wt_…")'),
            ...bundledGroups,
            ...setGroups,
            this.group('GM Instruments', cat.gm_instruments, 'gm', '+ any gm_* name'),
            this.group(
                'Your Samples',
                cat.user_sample_banks,
                'sample',
                cat.user_sample_banks.length
                    ? undefined
                    : 'Load a folder: ⌘⇧P → "Load Sample Folder…"',
            ),
        ].join('');
    }

    private group(label: string, names: string[], kind: SoundKind, hint?: string): string {
        const chips = names
            .map(n =>
                `<button class="sound-chip" data-name="${escapeHtml(n)}" data-kind="${kind}" ` +
                `data-tooltip="Insert ${escapeHtml(n)}">${escapeHtml(n)}</button>`,
            )
            .join('');
        const hintHtml = hint ? `<span class="sound-hint">${escapeHtml(hint)}</span>` : '';
        return `
            <div class="sound-group">
                <div class="sound-group-label">${escapeHtml(label)}<span class="sound-group-count">${names.length}</span></div>
                <div class="sound-chips">${chips}${hintHtml}</div>
            </div>`;
    }

    /** Apply the clicked sound at the cursor: replace a nearby s("…") if one
     *  exists, otherwise insert a fresh starter snippet. */
    private insert(name: string, kind: SoundKind): void {
        if (!name) return;
        const editor = window.strudelApp?.editor;
        if (!editor) return;

        // Smart replace: if cursor is near an existing s("…"), swap just the value.
        if (editor.replaceNearestSound(name)) return;

        // No nearby s() — insert a full snippet appropriate for the sound type.
        const melodic = kind === 'synth' || kind === 'gm';
        const snippet = melodic ? `note("c3 e3 g3").s("${name}")` : `s("${name}")`;
        editor.insertAtCursor(snippet);
    }

}

export const soundsBrowser = new SoundsBrowser();
