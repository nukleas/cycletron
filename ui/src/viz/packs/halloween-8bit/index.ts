import {type VizPack, validatePack} from '../../pack.js';
import manifest from './pack.json';
import {ghostFogDef} from './ghost-fog.js';
import {graveyardDef} from './graveyard.js';
import {hauntedHouseDef} from './haunted-house.js';
import {monsterBandDef} from './monster-band.js';

export const halloween8bit: VizPack = validatePack({
    manifest,
    modes: [graveyardDef, hauntedHouseDef, monsterBandDef, ghostFogDef],
    palettes: {
        pumpkin: {bg: '#0b0514', neon: '#ff7a1a', secondary: '#8a3cff', active: '#fff3b0', violet: '#5a2a9a', red: '#ff2e4d',
            more: ['#7cff3f', '#e6f0ff', '#e8dcc0']},
    },
});
