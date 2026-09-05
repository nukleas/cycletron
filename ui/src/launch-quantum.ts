/**
 * Launch quantization — hold an evaluated pattern until the bar line.
 *
 * Live coding normally swaps the pattern the instant you hit evaluate, which
 * puts the change wherever your typing happened to land. Ableton solved this
 * for clips with a global quantize setting; this is the same idea for the
 * whole buffer: pick a grid, and every swap waits for it.
 *
 * The scheduler owns the mechanism (see `PatternScheduler.setPatternQuantized`).
 * This module owns the setting, its persistence, and the toolbar button — a
 * cycling button in the metronome / skip family: each click steps to the next
 * grid, and while a swap is parked the label turns into a countdown.
 */

const STORAGE_KEY = 'launchQuantum';

/** Selectable grids, in cycles. One cycle is one bar at the `setbpm` convention. */
const CHOICES: Array<{ value: number; label: string; glyph: string }> = [
    {value: 0, label: 'Now', glyph: 'Q ·'},
    {value: 1, label: '1 bar', glyph: 'Q 1'},
    {value: 2, label: '2 bars', glyph: 'Q 2'},
    {value: 4, label: '4 bars', glyph: 'Q 4'},
    {value: 8, label: '8 bars', glyph: 'Q 8'},
];

class LaunchQuantum {
    /** Grid in cycles; `0` means swap immediately. */
    cycles = 0;

    private btn: HTMLButtonElement | null = null;
    private armedBoundary: number | null = null;
    private countdown = '';
    private onChange: ((cycles: number) => void) | null = null;

    /**
     * Bind the toolbar button. `onChange` receives every new grid value,
     * including the one restored from storage at startup.
     */
    init(onChange: (cycles: number) => void): void {
        this.onChange = onChange;

        const stored = Number(localStorage.getItem(STORAGE_KEY));
        this.cycles = CHOICES.some(c => c.value === stored) ? stored : 0;

        this.btn = document.getElementById('launchQuantumBtn') as HTMLButtonElement | null;
        this.btn?.addEventListener('click', () => this.cycleNext());

        this.onChange(this.cycles);
        this.render();
    }

    set(cycles: number): void {
        if (!CHOICES.some(c => c.value === cycles) || cycles === this.cycles) return;
        this.cycles = cycles;
        localStorage.setItem(STORAGE_KEY, String(cycles));
        this.onChange?.(cycles);
        this.render();
    }

    /** Step to the next grid — the button click, the command palette, a MIDI pad. */
    cycleNext(): void {
        const i = CHOICES.findIndex(c => c.value === this.cycles);
        this.set(CHOICES[(i + 1) % CHOICES.length].value);
    }

    get label(): string {
        return this.choice.label;
    }

    /** Scheduler callback: a swap is waiting for `boundary`, or has landed (`null`). */
    setArmed(boundary: number | null): void {
        this.armedBoundary = boundary;
        this.countdown = '';
        this.render();
    }

    /**
     * Transport callback: refresh the countdown. Called from the cycle update,
     * so it runs at frame rate — keep it to a text write on an integer change.
     */
    tick(cycle: number): void {
        if (this.armedBoundary === null) return;
        const barsAway = Math.max(0, Math.ceil(this.armedBoundary - cycle));
        const text = barsAway <= 1 ? 'next bar' : `${barsAway} bars`;
        if (text !== this.countdown) {
            this.countdown = text;
            this.render();
        }
    }

    private get choice() {
        return CHOICES.find(c => c.value === this.cycles) ?? CHOICES[0];
    }

    private render(): void {
        if (!this.btn) return;
        const armed = this.armedBoundary !== null;
        const {label, glyph} = this.choice;
        this.btn.textContent = armed && this.countdown ? `${glyph} · ${this.countdown}` : glyph;
        this.btn.classList.toggle('is-on', this.cycles > 0);
        this.btn.classList.toggle('is-armed', armed);
        this.btn.setAttribute(
            'data-tooltip',
            armed
                ? `Swap parked — lands on the ${this.countdown || 'bar line'}`
                : `Launch quantization: ${label} — click for the next grid`,
        );
    }
}

export const launchQuantum = new LaunchQuantum();
