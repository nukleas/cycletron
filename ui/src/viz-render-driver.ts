/**
 * The render page as a worker of `cycletron render` (src-tauri/src/render.rs
 * has the protocol). The first window to ask gets the show: it loads the
 * packs, parses the show, hands the songs over for export, cues each one
 * against its sections, and sends the cues back. Then every window pulls
 * chunks: set up the song at the chunk's first frame, paint each frame and
 * post its pixels, until no chunk is left.
 */
import {invoke, invokeRaw} from './tauri.js';
import {LOADED_PACKS, loadPackSource} from './viz/pack-loader.js';
import {VIZ_MODES} from './viz/registry.js';
import {cue, parseShow, ShowError, type FormSection} from './show/show.js';
import type {OfflineRender, RenderSetup} from './viz-render.js';

interface PackSource {
    id: string;
    source: string;
}

interface PlanRequest {
    show: string;
    dir: string;
    home: string;
    packs: PackSource[];
}

interface SongForm {
    index: number;
    sections: FormSection[];
}

interface Job extends Omit<RenderSetup, 'packs' | 'audio'> {
    count: number;
    packs: PackSource[];
    /** Which song's mix to fetch. */
    mix: number;
}

async function loadPacks(packs: PackSource[]): Promise<void> {
    for (const p of packs) {
        if (!LOADED_PACKS.has(p.id)) await loadPackSource(p.source, p.id);
    }
}

export async function runDriver(render: OfflineRender): Promise<void> {
    document.addEventListener('visibilitychange', () => {
        void invoke('render_hidden', {hidden: document.visibilityState === 'hidden'});
    });
    try {
        const plan = await invoke<PlanRequest | null>('render_plan');
        if (plan) {
            await loadPacks(plan.packs);
            const show = parseShow(plan.show, {dir: plan.dir, home: plan.home, modes: VIZ_MODES.map((m) => m.id)});
            const forms = await invoke<SongForm[]>('render_songs', {
                songs: show.songs.map((s) => ({index: s.index, source: s.source, passes: s.passes, performance: s.performance})),
            });
            const songs = show.songs.map((song) => {
                const form = forms.find((f) => f.index === song.index);
                if (!form) throw new Error(`no export came back for song ${song.index + 1}`);
                return {index: song.index, cues: cue(song, form.sections), fade: song.fade, gainDb: song.gainDb, sensitivity: song.sensitivity};
            });
            await invoke('render_cues', {payload: {songs, out: show.out, fps: show.fps, size: show.size, quality: show.quality}});
        }
        for (;;) {
            const job = await invoke<Job | null>('render_next');
            if (!job) break;
            await loadPacks(job.packs);
            // Where the chunk's time goes, in ms, for the render's closing summary.
            const timings = {setup: 0, update: 0, draw: 0, readback: 0, send: 0, frames: job.count, modes: 0};
            let t = performance.now();
            const lap = (key: 'setup' | 'readback' | 'send') => {
                const now = performance.now();
                timings[key] += now - t;
                t = now;
            };
            const mix = await invoke<ArrayBuffer>('render_mix', {index: job.mix});
            await render.setup({...job, packs: [], audio: mix});
            lap('setup');
            render.takeCosts();
            for (let i = 0; i < job.count; i++) {
                render.advance();
                t = performance.now();
                const pixels = render.rgba();
                lap('readback');
                await invokeRaw('render_frame', new Uint8Array(pixels.buffer), {});
                lap('send');
            }
            const costs = render.takeCosts();
            Object.assign(timings, {update: costs.update, draw: costs.draw, modes: costs.modes});
            await invoke('render_chunk_done', {timings});
        }
    } catch (e) {
        const message = e instanceof ShowError ? `${e.line ? `line ${e.line}: ` : ''}${e.message}`
            : e instanceof Error ? e.message : String(e);
        await invoke('render_failed', {message}).catch(() => {});
    }
}
