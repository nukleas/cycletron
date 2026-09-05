/**
 * Repaint Cycletron from the desktop's own theme.
 *
 * The backend hands over whatever palette the desktop publishes (Omarchy's
 * `colors.toml`), under that file's own names. Turning those into Cycletron's
 * look happens here, because this is where the CSS custom properties live —
 * every colour in `style.css` is already a `--token` on `:root`, so following
 * a theme is a matter of overriding tokens on the root element and dropping
 * the overrides again when the user turns it off.
 */

import {invoke, isTauri, listen} from './tauri.js';
import {diag} from './diagnostics.js';

interface DesktopTheme {
    mode: string;
    colors: Record<string, string>;
}

let following = false;

/** Tokens we set, so turning the feature off can put every one of them back. */
const OVERRIDDEN: string[] = [];

export async function initDesktopTheme(follow: boolean): Promise<void> {
    if (!isTauri) return;

    await listen<DesktopTheme | null>('desktop-theme-changed', ({payload}) => {
        if (following) apply(payload);
    });

    await setFollowDesktopTheme(follow);
}

export async function setFollowDesktopTheme(follow: boolean): Promise<void> {
    if (!isTauri) return;
    following = follow;

    if (!follow) {
        restore();
        return;
    }

    try {
        apply(await invoke<DesktopTheme | null>('get_desktop_theme'));
    } catch (e) {
        void diag('warn', 'theme', `could not read the desktop theme: ${e}`);
    }
}

function restore(): void {
    const root = document.documentElement;
    for (const token of OVERRIDDEN) root.style.removeProperty(token);
    OVERRIDDEN.length = 0;
}

function apply(theme: DesktopTheme | null): void {
    restore();
    if (!theme) return;

    const c = theme.colors;
    const pick = (...names: string[]): string | null => {
        for (const name of names) {
            const value = c[name];
            if (value) return value;
        }
        return null;
    };

    const accent = pick('accent', 'blue', 'cyan', 'color4');
    const background = pick('background');
    const foreground = pick('foreground');
    if (!accent || !background || !foreground) {
        void diag('warn', 'theme', 'desktop theme is missing background/foreground/accent');
        return;
    }

    const set = (token: string, value: string | null) => {
        if (!value) return;
        document.documentElement.style.setProperty(token, value);
        OVERRIDDEN.push(token);
    };

    // Surfaces, darkest first, the way style.css orders them.
    set('--bg', background);
    set('--bg-light', pick('lighter_background', 'selection', 'color8', 'color0'));
    set('--bg-lighter', pick('selection', 'muted', 'color8'));
    set('--border', pick('muted', 'dark_foreground', 'color8'));
    set('--surface-glass', alpha(pick('dark_background', 'color0') ?? background, 0.94));

    set('--text', pick('bright_foreground', 'light_foreground', 'color15') ?? foreground);
    set('--text-secondary', foreground);
    set('--text-muted', pick('dark_foreground', 'muted', 'color8'));

    set('--accent', accent);
    set('--accent-subtle', alpha(accent, 0.12));
    set('--selection', alpha(accent, 0.24));

    // Named colours are the Omarchy 4 table. Older themes only publish the
    // 16 terminal slots (color0–color15), which map the same way.
    const red = pick('red', 'color1');
    const yellow = pick('yellow', 'color3');
    const orange = pick('orange', 'yellow', 'color3');
    const green = pick('green', 'color2');
    const cyan = pick('cyan', 'blue', 'color6');
    const magenta = pick('magenta', 'color5');
    const brightRed = pick('bright_red', 'color9', 'red', 'color1');
    const brightYellow = pick('bright_yellow', 'color11', 'yellow', 'color3');
    const brightGreen = pick('bright_green', 'color10', 'green', 'color2');
    const brightMagenta = pick('bright_magenta', 'color13', 'magenta', 'color5');

    set('--red', red);
    set('--red-subtle', alpha(red ?? accent, 0.12));
    set('--danger-hover', brightRed);
    set('--orange', orange);
    set('--orange-bright', brightYellow);
    set('--orange-dark', pick('brown', 'orange', 'color3'));
    set('--yellow', yellow);
    set('--green-bright', brightGreen);
    // The dark green is a fill behind bright green text, not a text colour.
    set('--green', mix(green ?? accent, background, 0.78));
    set('--cyan', cyan);
    set('--magenta', magenta);
    set('--pink', brightMagenta);
    set('--purple', pick('magenta', 'blue', 'color5', 'color4'));
    set('--violet', brightMagenta);
    set('--rust', brightRed);

    // The neon layer: glows and hairlines derived from the two colours the
    // theme considers loudest, so the CRT look survives a palette it has
    // never seen.
    const secondary = pick('magenta', 'bright_magenta', 'red', 'color5', 'color1') ?? accent;
    set('--neon', accent);
    set('--neon-bright', mix(accent, '#ffffff', 0.55));
    set('--neon-subtle', alpha(accent, 0.2));
    set('--neon-glow', alpha(accent, 0.34));
    set('--neon-secondary', secondary);
    set('--neon-secondary-glow', alpha(secondary, 0.32));
    set('--pixel-grid', alpha(accent, 0.055));
    set('--panel-shadow', `inset 0 0 0 1px ${alpha(accent, 0.04)}, 0 0 24px ${alpha(accent, 0.07)}`);
    set('--sb-thumb', pick('selection', 'muted'));
    set('--sb-track', background);

    void diag(
        'info',
        'theme',
        `following desktop theme (${theme.mode}, bg ${background}, accent ${accent}, ` +
            `${OVERRIDDEN.length} tokens)`,
    );
}

/** `#rrggbb` → `rgba(r, g, b, a)`. Returns null on anything unparseable. */
function alpha(hex: string, a: number): string | null {
    const rgb = toRgb(hex);
    return rgb ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})` : null;
}

/** Blend `hex` toward `towards` by `amount` (0 = unchanged, 1 = fully). */
function mix(hex: string, towards: string, amount: number): string | null {
    const from = toRgb(hex);
    const to = toRgb(towards);
    if (!from || !to) return null;

    const channel = (i: number) => Math.round(from[i] * (1 - amount) + to[i] * amount);
    return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

function toRgb(hex: string): [number, number, number] | null {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
