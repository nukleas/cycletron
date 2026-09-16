/**
 * One normalized view of every playable sound, assembled in the frontend.
 *
 * Deliberately *not* a new Tauri command. `list_sounds` is the agent's
 * prose-annotated tool payload and the silence linter's input
 * (`src-tauri/src/sounds.rs` `sound_catalog`), consumed by the agent loop,
 * `editor-completions.ts` and `preferences.ts`. It is not a UI data model, and
 * shadowing it with a parallel Rust command would put the same facts in two
 * places with two drift surfaces. Everything the browser needs is already
 * reachable from commands that exist:
 *
 *   downloaded set  get_active_sample_set_manifests -> {id, dir, manifest}
 *   bundled set     GET /cycletron.strudel.json   (the artifact export renders from)
 *   packs           list_packs                    (bank name + resolved files)
 *   GM / synths     soundfont-tables.ts + list_sounds (names only — correct: no files)
 *
 * Reading the *generated* bundled manifest rather than `sample-tables.ts` is
 * deliberate: it is the same artifact the exporter resolves, so the browser is
 * structurally incapable of showing a bundled bank export cannot find. Never
 * add a fallback to `sample-tables.ts` — that would re-introduce the drift this
 * avoids.
 */

import {invoke, isTauri} from './tauri.js';
import {scoreText} from './fuzzy.js';
import {GM_BANK_NAMES} from '../soundfont-tables.js';
import type {SampleSourceManifest} from './types/tauri-commands.js';

export type BankSource = 'bundled' | 'set' | 'pack' | 'gm' | 'synth';
export type BankKind = 'pitched' | 'one-shot' | 'machine-voice' | 'synth' | 'gm';

/**
 * Where a sample's bytes come from. Bundled samples are same-origin URLs and
 * must be — in a production build `ui/public/` lives inside the rust-embed blob
 * with no stable on-disk path. Set and pack samples are real files.
 */
export type SampleRef =
    | {kind: 'url'; url: string; label: string; note?: string}
    | {kind: 'path'; path: string; label: string; note?: string};

export interface Bank {
    /** The `s("…")` token. */
    name: string;
    source: BankSource;
    kind: BankKind;
    /** Rail key. */
    category: string;
    /** Display grouping: 'Drums', a machine name, a pack name, a set id. */
    group: string;
    /** Provenance line shown in the detail pane. */
    origin: string;
    /** 0 means synthesised or streamed on demand. */
    count: number;
    machine?: string;
    samples: SampleRef[];
    auditionable: boolean;
    /** A pack bank whose name is shadowed by a core/set bank of the same name. */
    shadowed?: boolean;
    /** Pack banks only: the pack is installed but not enabled. */
    disabled?: boolean;
}

export interface Catalog {
    activeSet: string;
    banks: Bank[];
    byName: Map<string, Bank>;
    counts: Record<string, number>;
}

export interface CategoryDef {
    id: string;
    label: string;
}

/** Rail order. Empty categories are dropped by the views. */
export const CATEGORIES: readonly CategoryDef[] = [
    {id: 'all', label: 'All'},
    {id: 'drums', label: 'Drums'},
    {id: 'machines', label: 'Drum Machines'},
    {id: 'pitched', label: 'Pitched'},
    {id: 'one-shots', label: 'One-shots'},
    {id: 'synths', label: 'Synths'},
    {id: 'gm', label: 'General MIDI'},
    {id: 'packs', label: 'Packs'},
];

/** Bundled manifest shape: bank -> single path, indexed list, or note map. */
type ManifestValue = string | string[] | Record<string, string>;

const DEFAULT_DRUM_VOICES = new Set([
    'bd', 'sd', 'sn', 'hh', 'oh', 'hc', 'cp', 'cr', 'rd', 'rim', 'rs',
    'lt', 'mt', 'ht', 'lc', 'mc', 'cb', 'cl', 'click', 'tb', 'sh', 'ma',
]);

/**
 * MIRROR: src-tauri/src/sample_sets.rs `machine_voice` (~:564).
 * Splits `RolandTR909_bd` into machine + voice. The machine part must start
 * uppercase; both parts must be non-empty and alphanumeric.
 */
function machineVoice(name: string): {machine: string; voice: string} | null {
    const i = name.indexOf('_');
    if (i <= 0 || i === name.length - 1) return null;
    const machine = name.slice(0, i);
    const voice = name.slice(i + 1);
    if (!/^[A-Z][A-Za-z0-9]*$/.test(machine)) return null;
    if (!/^[a-z0-9]+$/.test(voice)) return null;
    return {machine, voice};
}

/**
 * MIRROR: src-tauri/src/sample_sets.rs `ActiveSetBanks::classify` (~:521).
 * An object value is a note map (pitched); everything else is indexed.
 */
function classifyBank(name: string, value: ManifestValue): {kind: BankKind; machine?: string} {
    if (value && !Array.isArray(value) && typeof value === 'object') return {kind: 'pitched'};
    const mv = machineVoice(name);
    if (mv) return {kind: 'machine-voice', machine: mv.machine};
    return {kind: 'one-shot'};
}

function categoryFor(kind: BankKind, source: BankSource, name: string): string {
    if (source === 'pack') return 'packs';
    if (source === 'gm') return 'gm';
    if (source === 'synth') return 'synths';
    if (kind === 'machine-voice') return 'machines';
    if (kind === 'pitched') return 'pitched';
    return DEFAULT_DRUM_VOICES.has(name) ? 'drums' : 'one-shots';
}

function basename(p: string): string {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i >= 0 ? p.slice(i + 1) : p;
}

/** Bundled manifest paths are relative to the served root. */
function bundledRef(rel: string): SampleRef {
    if (/^https?:\/\//i.test(rel)) {
        return {kind: 'url', url: rel, label: basename(rel), note: 'streams from upstream'};
    }
    return {kind: 'url', url: rel.startsWith('/') ? rel : `/${rel}`, label: basename(rel)};
}

function refsFor(value: ManifestValue, toRef: (rel: string) => SampleRef): SampleRef[] {
    if (typeof value === 'string') return [toRef(value)];
    if (Array.isArray(value)) return value.map(toRef);
    // Note map: the key is the musical label, which is more useful than the file.
    return Object.entries(value).map(([note, rel]) => ({...toRef(rel), label: note}));
}

function makeBank(
    name: string,
    value: ManifestValue,
    source: BankSource,
    origin: string,
    toRef: (rel: string) => SampleRef,
): Bank {
    const {kind, machine} = classifyBank(name, value);
    const samples = refsFor(value, toRef);
    return {
        name,
        source,
        kind,
        category: categoryFor(kind, source, name),
        group: machine ?? (source === 'bundled' ? 'Bundled' : origin),
        origin,
        count: samples.length,
        machine,
        samples,
        auditionable: samples.length > 0,
    };
}

interface PackBankSummary {
    name: string;
    files: string[];
}
interface PackSummary {
    id: string;
    name: string;
    enabled: boolean;
    banks: PackBankSummary[];
}

let cached: Catalog | null = null;
let pending: Promise<Catalog> | null = null;

if (typeof document !== 'undefined') {
    document.addEventListener('sounds:changed', () => {
        cached = null;
        pending = null;
    });
}

/** Assemble the catalog, memoized until `sounds:changed`. */
export function loadCatalog(): Promise<Catalog> {
    if (cached) return Promise.resolve(cached);
    pending ??= build().then((c) => {
        cached = c;
        pending = null;
        return c;
    });
    return pending;
}

async function build(): Promise<Catalog> {
    const banks: Bank[] = [];
    const byName = new Map<string, Bank>();
    let activeSet = 'cycletron';

    const add = (bank: Bank): void => {
        if (byName.has(bank.name)) {
            // First owner wins, mirroring the engine's registration order.
            if (bank.source === 'pack') bank.shadowed = true;
            else return;
        } else {
            byName.set(bank.name, bank);
        }
        banks.push(bank);
    };

    // 1. The active sound world: a downloaded set, or the bundled manifest.
    let sources: SampleSourceManifest[] | null = null;
    if (isTauri) {
        try {
            sources = await invoke<SampleSourceManifest[] | null>('get_active_sample_set_manifests');
        } catch (e) {
            console.warn('[sound-catalog] active sample set unavailable:', e);
        }
    }

    if (sources) {
        activeSet = sources[0]?.id ?? 'set';
        for (const source of sources) {
            for (const [name, value] of Object.entries(source.manifest)) {
                if (name.startsWith('_') || byName.has(name)) continue;
                add(makeBank(name, value as ManifestValue, 'set', source.id, (rel) => ({
                    kind: 'path',
                    path: `${source.dir}/${rel}`,
                    label: basename(rel),
                })));
            }
        }
    } else {
        // Bundled set active. This is the artifact export renders from — never
        // fall back to sample-tables.ts if it is missing; surface the error.
        const resp = await fetch('/cycletron.strudel.json');
        if (!resp.ok) throw new Error(`bundled manifest unavailable (${resp.status})`);
        const manifest = (await resp.json()) as Record<string, ManifestValue>;
        for (const [name, value] of Object.entries(manifest)) {
            if (name.startsWith('_')) continue;
            add(makeBank(name, value, 'bundled', 'Cycletron (bundled)', bundledRef));
        }
    }

    // 2. Packs — additive on top of whatever set is active.
    if (isTauri) {
        try {
            const packs = await invoke<PackSummary[]>('list_packs');
            for (const pack of packs) {
                for (const bank of pack.banks ?? []) {
                    const b = makeBank(
                        bank.name,
                        bank.files ?? [],
                        'pack',
                        pack.id,
                        (p) => ({kind: 'path', path: p, label: basename(p)}),
                    );
                    b.group = pack.name || pack.id;
                    b.disabled = !pack.enabled;
                    add(b);
                }
            }
        } catch (e) {
            console.warn('[sound-catalog] list_packs failed:', e);
        }
    }

    // 3. GM — 128 voices that stream from WebAudioFont on first use.
    for (const name of GM_BANK_NAMES) {
        if (byName.has(name)) continue;
        const bank: Bank = {
            name, source: 'gm', kind: 'gm', category: 'gm', group: 'General MIDI',
            origin: 'General MIDI', count: 0, samples: [], auditionable: false,
        };
        byName.set(name, bank);
        banks.push(bank);
    }

    // 4. Synths and wavetables — DSP, no files. The whole of list_sounds' role here.
    if (isTauri) {
        try {
            const cat = await invoke<{synths?: string[]; wavetables?: string[]}>('list_sounds');
            for (const name of [...(cat.synths ?? []), ...(cat.wavetables ?? [])]) {
                if (byName.has(name)) continue;
                const bank: Bank = {
                    name, source: 'synth', kind: 'synth', category: 'synths',
                    group: name.startsWith('wt_') ? 'Wavetables' : 'Synths',
                    origin: 'built in', count: 0, samples: [], auditionable: false,
                };
                byName.set(name, bank);
                banks.push(bank);
            }
        } catch (e) {
            console.warn('[sound-catalog] list_sounds failed:', e);
        }
    }

    const counts: Record<string, number> = {all: banks.length};
    for (const b of banks) counts[b.category] = (counts[b.category] ?? 0) + 1;

    return {activeSet, banks, byName, counts};
}

/** Filter + rank. Empty query keeps catalog order. */
export function filterBanks(banks: readonly Bank[], query: string): Bank[] {
    const q = query.trim().toLowerCase();
    if (!q) return banks.slice();
    return banks
        .map((b) => ({b, s: scoreText(b.name, `${b.group} ${b.origin}`, q)}))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.b.name.localeCompare(b.b.name))
        .map((x) => x.b);
}

/** The code a click should produce. Mirrors the old chip-grid policy. */
export function snippetFor(bank: Bank, sampleIndex?: number): string {
    const token = sampleIndex !== undefined && sampleIndex > 0
        ? `${bank.name}:${sampleIndex}`
        : bank.name;
    if (bank.kind === 'machine-voice' && bank.machine) {
        const voice = bank.name.slice(bank.machine.length + 1);
        return `s("${voice}").bank("${bank.machine}")`;
    }
    if (bank.kind === 'pitched' || bank.kind === 'gm' || bank.kind === 'synth') {
        return `note("c3 e3 g3").s("${token}")`;
    }
    return `s("${token}")`;
}
