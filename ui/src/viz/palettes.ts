/**
 * Named palettes a show recolors its visuals with. Every mode draws from the
 * {@link Theme} it's handed each frame, so swapping the theme recolors any
 * mode. `neon` is the app's own theme, as read from its CSS.
 */

import type {Theme} from './types.js';
import {hueOf, rgbOf} from './util.js';

type Rgb = [number, number, number];

interface Swatch {
    bg: string;
    /** Primary, secondary and highlight accents, then four more for track colors. */
    neon: string;
    secondary: string;
    active: string;
    violet: string;
    red: string;
    more: [string, string, string];
}

const SWATCHES = {
    amber: {bg: '#0a0603', neon: '#ffb000', secondary: '#ff5e1a', active: '#fff1c1', violet: '#c7792b', red: '#ff3d2e',
        more: ['#ffd36b', '#b8501d', '#ffe9a8']},
    ice: {bg: '#03070c', neon: '#9be7ff', secondary: '#4f7cff', active: '#ffffff', violet: '#8fa8ff', red: '#ff6b8b',
        more: ['#c8f4ff', '#2f5bd6', '#6fd3ff']},
    blood: {bg: '#080203', neon: '#ff2a3c', secondary: '#ff8c69', active: '#ffd6d6', violet: '#b0233a', red: '#ff0022',
        more: ['#7a0f1c', '#ff5a5a', '#ffb3a1']},
    sunset: {bg: '#0c0408', neon: '#ff7a59', secondary: '#c13cff', active: '#ffd166', violet: '#7b2fff', red: '#ff3b6b',
        more: ['#ff9eb5', '#f4a261', '#6a4cff']},
    vapor: {bg: '#0b0414', neon: '#ff71ce', secondary: '#01cdfe', active: '#fffb96', violet: '#b967ff', red: '#ff4f7b',
        more: ['#05ffa1', '#ff9de2', '#7af7ff']},
    toxic: {bg: '#030803', neon: '#7dff3a', secondary: '#d4ff00', active: '#ffffff', violet: '#3aff9d', red: '#ff3a3a',
        more: ['#1ec74a', '#f0ff6b', '#9dff7a']},
} satisfies Record<string, Swatch>;

export const PALETTES = ['neon', ...Object.keys(SWATCHES)] as readonly string[];

const themes = new Map<string, Theme>();

/** The theme for palette `name`; `neon` is `base`, the app's own. */
export function paletteTheme(name: string, base: Theme): Theme {
    if (name === 'neon') return base;
    let theme = themes.get(name);
    if (!theme) {
        const swatch = (SWATCHES as Record<string, Swatch>)[name];
        if (!swatch) throw new Error(`no palette '${name}' (have: ${PALETTES.join(', ')})`);
        theme = themeOf(swatch);
        themes.set(name, theme);
    }
    return theme;
}

function themeOf(p: Swatch): Theme {
    const rgb = (c: string): Rgb => rgbOf(c, [0, 0, 0]);
    const bg = rgb(p.bg);
    const neon = rgb(p.neon);
    return {
        bg: p.bg,
        neon: p.neon,
        neonSecondary: p.secondary,
        active: p.active,
        violet: p.violet,
        red: p.red,
        neonHue: hueOf(p.neon, 0),
        secondaryHue: hueOf(p.secondary, 0),
        activeHue: hueOf(p.active, 0),
        bgRgb: bg,
        bgLightRgb: mix(bg, neon, 0.04),
        bgLighterRgb: mix(bg, neon, 0.08),
        borderRgb: mix(bg, neon, 0.25),
        textRgb: mix(neon, [255, 255, 255], 0.5),
        accentPool: [p.neon, p.secondary, p.more[0], p.active, p.violet, p.more[1], p.red, p.more[2]].map(rgb),
    };
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
    return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as Rgb;
}
