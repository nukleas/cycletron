/** The packs compiled into the app. A downloaded pack will join this list at startup. */

import type {VizPack} from '../pack.js';
import {halloween8bit} from './halloween-8bit/index.js';

export const PACKS: readonly VizPack[] = [halloween8bit];
