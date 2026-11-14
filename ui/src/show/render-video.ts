/**
 * Render Video: the open show to a music video. The app binary's `render`
 * command does the work in its own process (src-tauri/src/video.rs), and its
 * progress shows in a toast in the bottom right, as an update download does. The render reads the show file
 * from disk, so unsaved edits are saved first.
 */

import {confirmDialog, errorDialog, infoDialog, saveFileDialog} from '../dialog.js';
import {addTask, removeTask} from '../dock-badge.js';
import {fileManager} from '../file-manager.js';
import {notify} from '../notifications.js';
import {basename} from '../paths.js';
import {ProgressToast} from '../progress-toast.js';
import {invoke, isTauri, listen} from '../tauri.js';
import {liveShow} from './live.js';
import {showPane} from './show-pane.js';
import {parseShow, ShowError, type RenderQuality, type Show} from './show.js';

type RenderEvent =
    | {event: 'exporting'; song: string}
    | {event: 'plan'; label: string; frames: number; out: string}
    | {event: 'frames'; done: number; total: number; fps: number}
    | {event: 'notice'; message: string}
    | {event: 'done'; out: string; seconds: number}
    | {event: 'error'; message: string}
    | {event: 'cancelled'};

const TASK = 'rendering-video';
/** How long the finished toast stays up, offering to show the file. */
const DONE_TOAST_MS = 15_000;

class VideoRender {
    private running = false;
    /** What the running render is of, from its plan. */
    private label = '';
    private readonly toast = new ProgressToast();
    private doneTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly cancelAction = {label: 'Cancel', run: () => this.cancel()};

    /** Wire the show pane's Render button and the render's events. Desktop only. */
    init(): void {
        if (!isTauri) return;
        const button = element('showPaneRender');
        button.hidden = false;
        button.addEventListener('click', () => void this.start());
        void listen<RenderEvent>('render-video', (e) => this.on(e.payload));
    }

    /** Render the open show to its `out`, or to a file picked now. */
    async start(): Promise<void> {
        if (!isTauri || this.running) return;
        const path = liveShow.showPath;
        const ctx = liveShow.showContext;
        if (!path || !ctx) {
            await infoDialog('Open a show file (.show.toml) to render it to a video.');
            return;
        }
        // The render reads the show and its songs from disk, so the open ones are saved first.
        const song = fileManager.isDirty ? fileManager.filePath : null;
        const unsaved = [showPane.isDirty ? path : null, song].filter((p): p is string => p !== null);
        if (unsaved.length) {
            const names = unsaved.map((p) => `"${basename(p)}"`).join(' and ');
            if (!(await confirmDialog(`The render reads ${names} from disk. Save your changes and render?`, {okLabel: 'Save and Render'}))) return;
            try {
                if (showPane.isDirty) await showPane.save();
            } catch (e) {
                await errorDialog(`Could not save the show:\n${e}`);
                return;
            }
            if (!(await fileManager.saveSong())) return;
        }
        let show: Show;
        try {
            show = parseShow(showPane.text, ctx);
        } catch (e) {
            const where = e instanceof ShowError && e.line ? ` (line ${e.line})` : '';
            await errorDialog(`Fix the show before rendering it${where}:\n${e instanceof Error ? e.message : e}`);
            return;
        }
        const options = await askOptions(path, show);
        if (!options) return;

        this.running = true;
        this.status('Starting the render…', 0);
        addTask(TASK);
        try {
            await invoke('render_video', {show: path, ...options});
        } catch (e) {
            this.end();
            this.toast.hide();
            await errorDialog(`Could not render:\n${e}`);
        }
    }

    cancel(): void {
        if (!this.running) return;
        this.status('Cancelling…', null, []);
        void invoke('cancel_render_video');
    }

    private on(e: RenderEvent): void {
        switch (e.event) {
            case 'exporting':
                this.status(`Exporting ${basename(e.song)}…`, null);
                break;
            case 'plan':
                this.status(`Rendering ${e.label}… 0%`, 0);
                this.label = e.label;
                break;
            case 'frames': {
                const fraction = e.done / e.total;
                this.status(`Rendering ${this.label}… ${Math.floor(100 * fraction)}%`, fraction);
                break;
            }
            case 'notice':
                console.info(`render: ${e.message}`);
                break;
            case 'done': {
                this.end();
                const out = e.out;
                this.toast.show(`✓ ${basename(out)} · ${e.seconds.toFixed(0)}s`, 1, [
                    {label: 'Show', run: () => void invoke('reveal_in_os', {path: out}).catch((err) => errorDialog(`Could not reveal:\n${err}`))},
                    {label: '×', run: () => this.toast.hide()},
                ]);
                this.doneTimer = setTimeout(() => this.toast.hide(), DONE_TOAST_MS);
                void notify('Video rendered', `${basename(out)} · ${e.seconds.toFixed(0)}s`);
                break;
            }
            case 'error':
                this.end();
                this.toast.hide();
                void errorDialog(`The render failed:\n${e.message}`);
                break;
            case 'cancelled':
                this.end();
                this.toast.hide();
                break;
        }
    }

    private end(): void {
        this.running = false;
        removeTask(TASK);
        this.renderButton();
    }

    /** The toast while rendering; Cancel unless told otherwise. */
    private status(text: string, fraction: number | null, actions = [this.cancelAction]): void {
        if (this.doneTimer !== null) clearTimeout(this.doneTimer);
        this.doneTimer = null;
        this.toast.show(text, fraction, actions);
        this.renderButton();
    }

    private renderButton(): void {
        const button = element('showPaneRender') as HTMLButtonElement;
        button.disabled = this.running;
        button.dataset.tooltip = this.running ? 'Rendering (progress in the bottom right)' : 'Render the show to a video file';
    }
}

interface RenderOptions {
    out: string;
    quality: RenderQuality;
    /** "WIDTHxHEIGHT", or null for the show's. */
    size: string | null;
}

const QUALITY_LABELS: Record<RenderQuality, string> = {
    standard: 'Standard (YouTube\'s recommended rate)',
    small: 'Small (for sharing)',
    master: 'Master (to edit further)',
};

/** About how many MB a minute of video takes; mirrors `Quality::rate` in src-tauri/src/render.rs. */
function megabytesPerMinute(quality: RenderQuality, width: number, height: number, fps: number): number {
    const scale = ((width * height * fps) / (1920 * 1080 * 60)) ** 0.75;
    // Master is uncapped; ~26 Mbps is what busy 1080p60 shows measured at crf 16.
    const kbps = {standard: 12_000, small: 6_000, master: 26_000}[quality] * scale;
    return (Math.max(kbps, 1_000) * 60) / 8 / 1024;
}

/** Quality, frame size and output file, before a render. Null if cancelled. */
function askOptions(path: string, show: Show): Promise<RenderOptions | null> {
    const own = show.size ?? {width: 1920, height: 1080};
    const fps = show.fps ?? 60;
    const sizes = [{value: '', width: own.width, height: own.height, label: `${own.width}×${own.height} (the show's)`}];
    for (const [width, height] of [[1920, 1080], [1280, 720]]) {
        if (width !== own.width || height !== own.height) sizes.push({value: `${width}x${height}`, width, height, label: `${width}×${height}`});
    }
    let out = show.out;
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'picker-overlay';
        overlay.innerHTML = `
            <div class="picker-modal export-modal">
                <div class="picker-header">
                    <span class="picker-title">Render Video</span>
                    <button class="picker-close" type="button" aria-label="Close">&times;</button>
                </div>
                <p class="export-modal-help">Renders <code></code> at ${fps} fps. The quality can be set in the show too: <code>quality = "small"</code> under <code>[show]</code>.</p>
                <label class="export-modal-field">
                    <span>Quality</span>
                    <select id="renderQuality">${Object.entries(QUALITY_LABELS).map(([q, label]) =>
                        `<option value="${q}"${q === (show.quality ?? 'standard') ? ' selected' : ''}>${label}</option>`).join('')}</select>
                </label>
                <label class="export-modal-field">
                    <span>Size</span>
                    <select id="renderSize">${sizes.map((s, i) => `<option value="${i}">${s.label}</option>`).join('')}</select>
                </label>
                <div class="export-modal-field">
                    <span>Save to</span>
                    <button type="button" id="renderOut" class="export-cancel"></button>
                </div>
                <p class="export-modal-meta" id="renderMeta"></p>
                <div class="export-modal-actions">
                    <button type="button" class="export-cancel">Cancel</button>
                    <button type="button" class="export-confirm primary">Render</button>
                </div>
            </div>
        `;
        overlay.querySelector('.export-modal-help code')!.textContent = basename(path);
        const quality = overlay.querySelector<HTMLSelectElement>('#renderQuality')!;
        const size = overlay.querySelector<HTMLSelectElement>('#renderSize')!;
        const outButton = overlay.querySelector<HTMLButtonElement>('#renderOut')!;
        const meta = overlay.querySelector<HTMLElement>('#renderMeta')!;
        const update = () => {
            const s = sizes[Number(size.value)];
            const mb = megabytesPerMinute(quality.value as RenderQuality, s.width, s.height, fps);
            meta.textContent = `About ${Math.round(mb / 5) * 5 || 1} MB per minute of video.`;
            outButton.textContent = out ? basename(out) : 'Choose…';
            outButton.title = out ?? '';
        };
        const pick = async (): Promise<boolean> => {
            const picked = await saveFileDialog({
                defaultPath: out ?? `${basename(path).replace(/\.show\.toml$|\.toml$/, '')}.mp4`,
                filters: [{name: 'Video', extensions: ['mp4']}],
            });
            if (picked) out = picked;
            update();
            return picked !== null;
        };
        const close = (value: RenderOptions | null) => {
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            resolve(value);
        };
        const confirm = async () => {
            if (!out && !(await pick())) return;
            close({out: out!, quality: quality.value as RenderQuality, size: sizes[Number(size.value)].value || null});
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close(null);
            } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
                e.preventDefault();
                void confirm();
            }
        };
        quality.addEventListener('change', update);
        size.addEventListener('change', update);
        outButton.addEventListener('click', () => void pick());
        overlay.querySelector('.picker-close')!.addEventListener('click', () => close(null));
        overlay.querySelector('.export-modal-actions .export-cancel')!.addEventListener('click', () => close(null));
        overlay.querySelector('.export-confirm')!.addEventListener('click', () => void confirm());
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
        document.addEventListener('keydown', onKey, true);
        update();
        document.body.appendChild(overlay);
        quality.focus();
    });
}

function element(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error(`render video: #${id} is missing`);
    return el;
}

export const videoRender = new VideoRender();
