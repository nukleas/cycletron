/**
 * "Visuals" header dropdown — the single home for visualization settings:
 * Sequence Grid mode (Cycle / Piano Roll / Waveform), the ambient fullscreen
 * visualizer on/off + mode, and auto-cycling.
 *
 * State lives elsewhere (localStorage for the grid mode, the ambientViz
 * singleton for everything ambient); the menu just reflects it. Checked
 * states refresh on every open and whenever ambientViz fires onStateChange,
 * so HUD buttons, [ / ] keys, Ctrl+Shift+V, and auto-cycle all stay in sync
 * with an open menu.
 */

import {ambientViz} from './ambient-viz.js';
import {stage, STAGE_PRESETS, STAGE_TEXT_SIZES} from './stage.js';
import {attachDropdown} from './dropdown.js';
import {VIZ_MODES} from './viz/registry.js';
import {VizMode} from './types/visualizer.js';

const GRID_MODE_KEY = 'visualizer-mode';
const READABLE_KEY = 'readable-mode';
// Missing key = on: the CRT scanline overlay is part of the house style.
const SCANLINES_KEY = 'scanlines';

const GRID_MODES: ReadonlyArray<{ mode: VizMode; label: string }> = [
    {mode: VizMode.Cycle, label: 'Cycle View'},
    {mode: VizMode.Piano, label: 'Piano Roll'},
    {mode: VizMode.Waveform, label: 'Waveform'},
];

interface VisualsMenuOptions {
    onGridModeChange: (mode: VizMode) => void;
}

class VisualsMenu {
    private btn: HTMLButtonElement | null = null;
    private menu: HTMLDivElement | null = null;
    private opts: VisualsMenuOptions | null = null;

    private gridItems: HTMLButtonElement[] = [];
    private ambientToggleItem: HTMLButtonElement | null = null;
    private ambientHint: HTMLSpanElement | null = null;
    private autoCycleItem: HTMLButtonElement | null = null;
    private readableItem: HTMLButtonElement | null = null;
    private scanlinesItem: HTMLButtonElement | null = null;
    private modeItems: HTMLButtonElement[] = [];
    private stageToggleItem: HTMLButtonElement | null = null;
    private stageHudItem: HTMLButtonElement | null = null;
    private stageFullscreenItem: HTMLButtonElement | null = null;
    private stageResItems: HTMLButtonElement[] = [];
    private stageTextItems: HTMLButtonElement[] = [];

    init(opts: VisualsMenuOptions): void {
        this.opts = opts;
        this.btn = document.getElementById('visualsMenuBtn') as HTMLButtonElement | null;
        this.menu = document.getElementById('visualsMenu') as HTMLDivElement | null;
        if (!this.btn || !this.menu) return;

        applyReadableMode(localStorage.getItem(READABLE_KEY) === '1');
        applyScanlines(localStorage.getItem(SCANLINES_KEY) !== '0');

        this.build();

        attachDropdown({
            button: this.btn,
            menu: this.menu,
            onOpen: () => this.refresh(),
        });

        ambientViz.onStateChange = () => this.refresh();
        stage.onStateChange = () => this.refresh();
    }

    // ---- construction -------------------------------------------------

    private item(label: string, role: 'menuitemradio' | 'menuitemcheckbox', onClick: () => void): HTMLButtonElement {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', role);
        b.setAttribute('aria-checked', 'false');
        b.tabIndex = -1;
        const text = document.createElement('span');
        text.className = 'menu-item-label';
        text.textContent = label;
        b.appendChild(text);
        b.addEventListener('click', onClick);
        return b;
    }

    private section(title: string): HTMLDivElement {
        const d = document.createElement('div');
        d.className = 'menu-section';
        d.textContent = title;
        return d;
    }

    private hint(text: string): HTMLSpanElement {
        const s = document.createElement('span');
        s.className = 'menu-item-hint';
        s.textContent = text;
        return s;
    }

    private build(): void {
        const menu = this.menu!;
        menu.textContent = '';

        menu.appendChild(this.section('Sequence Grid'));
        this.gridItems = GRID_MODES.map(({mode, label}) => {
            const b = this.item(label, 'menuitemradio', () => {
                localStorage.setItem(GRID_MODE_KEY, String(mode));
                this.opts?.onGridModeChange(mode);
                this.refresh();
            });
            menu.appendChild(b);
            return b;
        });

        menu.appendChild(document.createElement('hr'));

        menu.appendChild(this.section('Ambient'));
        this.ambientToggleItem = this.item('Ambient Visualizer', 'menuitemcheckbox', () => {
            ambientViz.toggle();
        });
        this.ambientHint = this.hint('Ctrl+Shift+V');
        this.ambientToggleItem.appendChild(this.ambientHint);
        menu.appendChild(this.ambientToggleItem);

        this.autoCycleItem = this.item('Auto-cycle Modes', 'menuitemcheckbox', () => {
            ambientViz.setAutoCycle(!ambientViz.isAutoCycle());
        });
        menu.appendChild(this.autoCycleItem);

        menu.appendChild(document.createElement('hr'));

        menu.appendChild(this.section('Stage'));
        this.stageToggleItem = this.item('Stage Mode', 'menuitemcheckbox', () => {
            void stage.toggle();
        });
        this.stageToggleItem.appendChild(this.hint('⌘⇧F'));
        menu.appendChild(this.stageToggleItem);

        this.stageHudItem = this.item('Stage Readout', 'menuitemcheckbox', () => {
            stage.setHudVisible(!stage.isHudVisible());
            this.refresh();
        });
        this.stageHudItem.appendChild(this.hint('mode, BPM, cycle'));
        menu.appendChild(this.stageHudItem);

        this.stageFullscreenItem = this.item('Enter Fullscreen on Stage', 'menuitemcheckbox', () => {
            stage.setOsFullscreenPref(!stage.isOsFullscreen());
            this.refresh();
        });
        menu.appendChild(this.stageFullscreenItem);

        // Code size doubles as how much of the frame the code covers, so it is
        // the first thing reached for once the visuals are the point. ⌘+/⌘−
        // does it live on stage; this is where you find out that it does.
        this.stageTextItems = STAGE_TEXT_SIZES.map((size, i) => {
            const b = this.item(`Code: ${size.label}`, 'menuitemradio', () => {
                stage.setTextSize(size.id);
                this.refresh();
            });
            if (i === 0) b.appendChild(this.hint('⌘+ / ⌘− on stage'));
            menu.appendChild(b);
            return b;
        });

        // Output resolution is what a recorder or an OBS window capture gets,
        // so it belongs next to the stage toggle rather than buried in prefs.
        this.stageResItems = STAGE_PRESETS.map((preset) => {
            const b = this.item(preset.label, 'menuitemradio', () => {
                stage.setResolution(preset.id);
                this.refresh();
            });
            menu.appendChild(b);
            return b;
        });

        menu.appendChild(document.createElement('hr'));

        menu.appendChild(this.section('Display'));
        this.readableItem = this.item('Readable Mode', 'menuitemcheckbox', () => {
            const on = !(localStorage.getItem(READABLE_KEY) === '1');
            localStorage.setItem(READABLE_KEY, on ? '1' : '0');
            applyReadableMode(on);
            this.refresh();
        });
        this.readableItem.appendChild(this.hint('bigger text, less glow'));
        menu.appendChild(this.readableItem);

        this.scanlinesItem = this.item('Scanlines', 'menuitemcheckbox', () => {
            const on = localStorage.getItem(SCANLINES_KEY) === '0'; // flipping
            localStorage.setItem(SCANLINES_KEY, on ? '1' : '0');
            applyScanlines(on);
            this.refresh();
        });
        this.scanlinesItem.appendChild(this.hint('CRT overlay'));
        menu.appendChild(this.scanlinesItem);

        menu.appendChild(document.createElement('hr'));

        menu.appendChild(this.section('Ambient Mode'));
        this.modeItems = [];
        VIZ_MODES.forEach((def, mode) => {
            const b = this.item(def.name, 'menuitemradio', () => {
                ambientViz.setMode(mode);
            });
            this.modeItems[mode] = b;
            menu.appendChild(b);
        });

        this.refresh();
    }

    // ---- state --------------------------------------------------------

    private refresh(): void {
        if (!this.menu) return;

        const savedGrid = parseInt(localStorage.getItem(GRID_MODE_KEY) ?? '0', 10);
        const gridMode = (Number.isInteger(savedGrid) && savedGrid >= 0 && savedGrid < GRID_MODES.length
            ? savedGrid : 0) as VizMode;
        this.gridItems.forEach((b, i) =>
            b.setAttribute('aria-checked', String(GRID_MODES[i].mode === gridMode)));

        this.ambientToggleItem?.setAttribute('aria-checked', String(ambientViz.isEnabled()));
        if (this.ambientHint) {
            this.ambientHint.textContent = ambientViz.isEnabled() && !ambientViz.isAttached()
                ? 'starts with audio'
                : 'Ctrl+Shift+V';
        }
        this.autoCycleItem?.setAttribute('aria-checked', String(ambientViz.isAutoCycle()));
        this.readableItem?.setAttribute('aria-checked', String(localStorage.getItem(READABLE_KEY) === '1'));
        this.scanlinesItem?.setAttribute('aria-checked', String(localStorage.getItem(SCANLINES_KEY) !== '0'));

        this.stageToggleItem?.setAttribute('aria-checked', String(stage.isActive()));
        this.stageHudItem?.setAttribute('aria-checked', String(stage.isHudVisible()));
        this.stageFullscreenItem?.setAttribute('aria-checked', String(stage.isOsFullscreen()));
        const resolutionId = stage.resolution().id;
        this.stageResItems.forEach((b, i) =>
            b.setAttribute('aria-checked', String(STAGE_PRESETS[i].id === resolutionId)));
        const textSizeId = stage.textSize().id;
        this.stageTextItems.forEach((b, i) =>
            b.setAttribute('aria-checked', String(STAGE_TEXT_SIZES[i].id === textSizeId)));

        const ambientMode = ambientViz.getMode();
        this.modeItems.forEach((b, i) => b?.setAttribute('aria-checked', String(i === ambientMode)));
    }

}

function applyReadableMode(on: boolean): void {
    document.documentElement.classList.toggle('readable-mode', on);
}

function applyScanlines(on: boolean): void {
    document.documentElement.classList.toggle('no-scanlines', !on);
}

export const visualsMenu = new VisualsMenu();
