/**
 * The public surface a visualizer pack may use. Pack code imports
 * `@cycletron/viz-sdk` and nothing else from the app, so what a pack can see
 * is this one list. The app's own modes import the same package.
 */

export type {PatternQuery, PatternSource, Theme, VizLayer, VizMode, VizModeDef, VizServices} from './types.js';
export {HapField} from './hap-field.js';
export type {FieldHap, FieldTeam, HapFieldConfig, Rgb} from './hap-field.js';
export {
    MAX_EVENTS_PER_TRACK, MAX_TRACKS, VIEW_CAPACITY, PatternTimeline, TrackModel, drumOnsets, instrumentFamily,
} from './tracks.js';
export type {InstrumentFamily, OnsetHandler, TrackSync, VizTrack} from './tracks.js';
export {
    MONO_FONT, TAU, SeededRandom, TransientDetector, alphaRamp, barHue, beatEnv, clamp01, drawLabel, follow, hash32,
    hueOf, lerpRgb, mixRgb, rampAt, rand01, rgbOf,
} from './util.js';
export type {Transients} from './util.js';
export {validatePack, sdkSatisfies} from './pack.js';
export type {PackManifest, Swatch, VizPack} from './pack.js';
export {PW, PH, PxScreen, spr, drawSprite, frameRect, fillTri, nearest} from './pixel.js';
export type {Sprite, DrawOpt} from './pixel.js';

import {version} from '../package.json';
/** The sdk's version, the package version. A pack declares the range it needs in its manifest (`sdk`). Semver: a breaking change here bumps the major. */
export const SDK_VERSION: string = version;
