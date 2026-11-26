/**
 * Every part the shelf can offer: lanes cut from the bundled corpus, from the
 * genre recipes, and from the user's own `Parts/` folder in the library.
 */

import {invoke, isTauri} from '../tauri.js';
import {loadGenreExamples, loadTechniqueExamples} from '../examples-from-files.js';
import {classify, nameFromCode, splitLanes, tidy, ROLES, type Role} from './split.js';

export type PartSource = 'corpus' | 'recipe' | 'mine';

export interface Part {
    id: string;
    title: string;
    role: Role;
    genre: string | null;
    bpm: number | null;
    code: string;
    source: PartSource;
    /** Set on imported parts: the dataset or folder they came from. */
    collection?: string | null;
    key?: string | null;
    bars?: number | null;
    /** Top folder of the file the part was cut from, e.g. a pack's "soul style". */
    folder?: string | null;
    /** Name before review: the source file and track. */
    song?: string | null;
    /** 1 to 5 from a review. */
    rating?: number | null;
    tags?: string[];
    /** Parts with the same kit share a key and a progression. */
    kit?: string | null;
}

/** Library folder that holds saved parts, one subfolder per role. */
export const PARTS_DIR = 'Parts';

interface SourceText {
    id: string;
    name: string;
    text: string;
    source: PartSource;
    genre?: string | null;
    bpm?: number | null;
    /** Set when the caller already knows the role (a saved part's folder). */
    role?: Role;
    /**
     * Generator output. Its drum line is a usable genre groove; its bass, chords
     * and lead are a few stock rhythms with generated notes, so they are left out.
     */
    generated?: boolean;
}

/**
 * Cut one source text into parts. Drum lanes stay together as one beat, and a
 * saved part is never split: both come back as a single `stack(…)`.
 */
export function partsFrom(src: SourceText): Part[] {
    const {bpm, lanes} = splitLanes(src.text);
    const whole = lanes.length === 1;
    const roled = lanes.map((lane) => ({
        lane,
        role: src.role ?? classify(whole ? src.name : (lane.label ?? ''), lane.code),
    }));
    const together = roled.filter((l) => src.role || l.role === 'drums');
    const merged = together.length > 1;

    const part = (i: number, role: Role, title: string, code: string): Part => ({
        id: `${src.id}#${i}`,
        title,
        role,
        genre: src.genre ?? null,
        bpm: bpm ?? src.bpm ?? null,
        code,
        source: src.source,
    });

    const parts: Part[] = [];
    roled.forEach(({lane, role}, i) => {
        if (merged && together.some((l) => l.lane === lane)) {
            if (lane !== together[0].lane) return;
            const title = together.length === lanes.length ? src.name : `${src.name} · ${role}`;
            parts.push(part(i, role, title, stackOf(together.map((l) => l.lane.code))));
            return;
        }
        // A drum lane is known by its sound, anything else by what it does.
        const own = (role === 'drums' || role === 'other' ? nameFromCode(lane.code) : null)
            ?? (role === 'other' ? `part ${i + 1}` : role);
        parts.push(part(i, role, whole ? src.name : (lane.label ?? `${src.name} · ${own}`), lane.code));
    });
    return src.generated ? parts.filter((p) => p.role === 'drums') : parts;
}

function stackOf(codes: string[]): string {
    return `stack(\n${codes.map((c) => `  ${c.replace(/\n/g, '\n  ')}`).join(',\n')}\n)`;
}

let cachedCorpus: Part[] | null = null;

function corpusParts(): Part[] {
    if (cachedCorpus) return cachedCorpus;
    const techniques = loadTechniqueExamples()
        .filter((ex) => !ex.tags.includes('form'))
        .map((ex) => partsFrom({id: `corpus:${ex.title}`, name: ex.title, text: ex.code, source: 'corpus'}));
    const genres = loadGenreExamples().map((ex) => partsFrom({
        id: `genre:${ex.title}`,
        name: ex.title,
        text: ex.code,
        source: 'corpus',
        genre: ex.tags.find((t) => t !== 'genres') ?? null,
        generated: ex.generated,
    }));
    cachedCorpus = [...techniques, ...genres].flat();
    return cachedCorpus;
}

interface Recipe {
    genre: string;
    bpm: [number, number] | null;
    sections: {fragments: {label: string; code: string}[]}[];
}

let cachedRecipes: Promise<Part[]> | null = null;

async function recipeParts(): Promise<Part[]> {
    if (!isTauri) return [];
    if (!cachedRecipes) {
        cachedRecipes = invoke<Recipe[]>('genre_recipe', {genre: null}).then((recipes) =>
            recipes.flatMap((r) => {
                const fragments = r.sections.flatMap((s) => s.fragments);
                // A recipe with one fragment is the generated skeleton. A detailed
                // recipe's skeleton only repeats its named fragments.
                const generated = fragments.length === 1;
                return fragments
                    .filter((f) => generated || !f.label.startsWith('Full skeleton'))
                    .flatMap((f) => partsFrom({
                        id: `recipe:${r.genre}:${f.label}`,
                        name: f.label,
                        text: f.code,
                        source: 'recipe',
                        genre: r.genre,
                        bpm: r.bpm ? Math.round((r.bpm[0] + r.bpm[1]) / 2) : null,
                        generated,
                    }));
            }),
        ).catch((err) => {
            cachedRecipes = null;
            throw err;
        });
    }
    return cachedRecipes;
}

export interface SavedPartRecord {
    path: string;
    name: string;
    role: string;
    bpm: number | null;
    bars: number | null;
    key: string | null;
    collection: string | null;
    license: string | null;
    song: string | null;
    source: string | null;
    rating: number | null;
    tags: string[];
    kit: string | null;
    code: string;
}

/** Header tags that only repeat the role and collection. */
function ownTags(p: SavedPartRecord): string[] {
    return p.tags.filter((t) => t !== 'part' && t !== p.role && t !== p.collection);
}

const FAST_PART_START = /^(?:note|n|s|sound|stack|cat|seq|chord|freq)\s*\(/;
const FAST_PART_DISQUALIFY = /\/\/|\/\*|\$:|\b(?:set(?:bpm|cpm)|const|let|var|function|class|import|export|if|for|while|return)\b|\.(?:pick|inhabit)\w*\s*\(|\barrange\s*\(|;/;

/**
 * Fast path for clean single-expression saved parts: skips the JS parser when
 * the body has no comments, directives, tracks, or multi-statement syntax.
 */
export function fastSavedCode(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed || !FAST_PART_START.test(trimmed) || !trimmed.endsWith(')')) return null;
    if (FAST_PART_DISQUALIFY.test(trimmed)) return null;
    if (trimmed.includes('\n')) {
        const lines = trimmed.split('\n');
        // Reject multiple top-level statements; continuation lines indent or close the call.
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (line && !/^[\s.)\]}]/.test(line)) return null;
        }
    } else if (/^stack\s*\(/.test(trimmed) || /\)\s+[A-Za-z_$]/.test(trimmed)) {
        return null;
    }
    return tidy(trimmed);
}

/** Convert one backend saved-part record into shelf Part(s). */
export function savedRecordToParts(p: SavedPartRecord): Part[] {
    const role: Role = ROLES.includes(p.role as Role) ? (p.role as Role) : 'other';
    const meta = {
        collection: p.collection,
        key: p.key,
        bars: p.bars,
        folder: p.source?.includes('/') ? p.source.split('/')[0] : null,
        song: p.song,
        rating: p.rating,
        tags: ownTags(p),
        kit: p.kit,
    };
    const fast = fastSavedCode(p.code);
    if (fast !== null) {
        return [{
            id: `mine:${p.path}#0`,
            title: p.name,
            role,
            genre: null,
            bpm: p.bpm,
            code: fast,
            source: 'mine',
            ...meta,
        }];
    }
    return partsFrom({
        id: `mine:${p.path}`,
        name: p.name,
        text: p.code,
        source: 'mine',
        bpm: p.bpm,
        role,
    }).map((part) => ({...part, ...meta}));
}

async function savedParts(): Promise<Part[]> {
    if (!isTauri) return [];
    const saved = await invoke<SavedPartRecord[]>('list_saved_parts');
    const out: Part[] = [];
    for (const record of saved) {
        for (const part of savedRecordToParts(record)) out.push(part);
    }
    return out;
}

/**
 * The whole catalog, own parts first. Recipes and saved parts need the
 * backend; without it the bundled corpus still loads.
 */
export async function loadParts(): Promise<Part[]> {
    const [mine, recipes] = await Promise.all([
        savedParts().catch(() => []),
        recipeParts().catch(() => []),
    ]);
    const seen = new Set<string>();
    return [...mine, ...recipes, ...corpusParts()].filter((p) => {
        if (seen.has(p.code)) return false;
        seen.add(p.code);
        return true;
    });
}
