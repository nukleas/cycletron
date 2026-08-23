/** Read the app's CSS-variable palette into a canvas-friendly Theme. */

import type {Theme} from './types.js';
import {hueOf, rgbOf} from './util.js';

export function readTheme(): Theme {
    const style = getComputedStyle(document.documentElement);
    const css = (name: string, fallback: string): string =>
        style.getPropertyValue(name).trim() || fallback;

    return {
        bg: css('--bg', '#05060a'),
        neon: css('--neon', '#47f6ff'),
        neonSecondary: css('--neon-secondary', '#ff2bd6'),
        active: css('--viz-active', '#f7ff5a'),
        violet: css('--violet', '#9d7cff'),
        red: css('--red', '#ff456c'),
        neonHue: hueOf(css('--neon', '#47f6ff'), 185),
        secondaryHue: hueOf(css('--neon-secondary', '#ff2bd6'), 315),
        activeHue: hueOf(css('--viz-active', '#f7ff5a'), 55),
        bgRgb: rgbOf(css('--bg', '#05060a'), [5, 6, 10]),
        bgLightRgb: rgbOf(css('--bg-light', '#0b0f18'), [11, 15, 24]),
        bgLighterRgb: rgbOf(css('--bg-lighter', '#111827'), [17, 24, 39]),
        borderRgb: rgbOf(css('--border', '#26324c'), [38, 50, 76]),
        textRgb: rgbOf(css('--text-secondary', '#a7b7d6'), [167, 183, 214]),
        accentPool: [
            rgbOf(css('--neon', '#47f6ff'), [71, 246, 255]),
            rgbOf(css('--neon-secondary', '#ff2bd6'), [255, 43, 214]),
            rgbOf(css('--green-bright', '#52ff9f'), [82, 255, 159]),
            rgbOf(css('--viz-active', '#f7ff5a'), [247, 255, 90]),
            rgbOf(css('--violet', '#9d7cff'), [157, 124, 255]),
            rgbOf(css('--orange', '#ffb000'), [255, 176, 0]),
            rgbOf(css('--red', '#ff456c'), [255, 69, 108]),
            [106, 168, 255],
        ],
    };
}

/** Neutral palette used before start() reads the live CSS variables. */
export function defaultTheme(): Theme {
    return {
        bg: '#05060a',
        neon: '#47f6ff',
        neonSecondary: '#ff2bd6',
        active: '#f7ff5a',
        violet: '#9d7cff',
        red: '#ff456c',
        neonHue: 185,
        secondaryHue: 315,
        activeHue: 55,
        bgRgb: [5, 6, 10],
        bgLightRgb: [11, 15, 24],
        bgLighterRgb: [17, 24, 39],
        borderRgb: [38, 50, 76],
        textRgb: [167, 183, 214],
        accentPool: [
            [71, 246, 255],
            [255, 43, 214],
            [82, 255, 159],
            [247, 255, 90],
            [157, 124, 255],
            [255, 176, 0],
            [255, 69, 108],
            [106, 168, 255],
        ],
    };
}
