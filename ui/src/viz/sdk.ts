/**
 * The public surface a visualizer pack may use. Pack code imports from this
 * file and nothing else under `viz/`, so what a pack can see is one list.
 */

export type {PatternSource, Theme, VizLayer, VizMode, VizModeDef, VizServices} from './types.js';
export {HapField} from './hap-field.js';
export type {FieldHap, FieldTeam, HapFieldConfig, Rgb} from './hap-field.js';
export {TrackModel, instrumentFamily} from './tracks.js';
export type {InstrumentFamily, VizTrack} from './tracks.js';
export {
    TAU, SeededRandom, TransientDetector, alphaRamp, beatEnv, clamp01, drawLabel, follow, hash32, lerpRgb,
    mixRgb, rampAt, rand01, rgbOf,
} from './util.js';
export {validatePack, sdkSatisfies} from './pack.js';
export {PW, PH, PxScreen, spr, drawSprite, frameRect, fillTri, nearest} from './pixel.js';
export type {Sprite, DrawOpt} from './pixel.js';

/** The sdk's version. A pack declares the range it needs in its manifest (`sdk`). Semver: a breaking change here bumps the major. */
export const SDK_VERSION = '1.1.0';
export type {PackManifest, Swatch, VizPack} from './pack.js';
