#!/usr/bin/env node
/**
 * Copy Fischer 808 knob takes + selected uzu-drumkit voices into
 * `ui/public/samples/`. Source of truth for *which* files belong in the
 * default kit is `ui/sample-tables.ts` (ESSENTIAL_DRUMS); this script only
 * fetches them. Re-run after cloning:
 *
 *   git clone --depth 1 https://github.com/tidalcycles/sounds-tr808-fischer.git /tmp/sounds-tr808-fischer
 *   git clone --depth 1 https://github.com/tidalcycles/uzu-drumkit.git /tmp/uzu-drumkit
 *   node ui/scripts/vendor-core-drums.mjs
 */
import {cpSync, mkdirSync, existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {ESSENTIAL_DRUMS} from '../sample-tables.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES = resolve(HERE, '../public/samples');
const FISCHER = process.env.FISCHER_808 || '/tmp/sounds-tr808-fischer';
const UZU = process.env.UZU_DRUMKIT || '/tmp/uzu-drumkit';

let copied = 0;
let missing = 0;
for (const {files} of ESSENTIAL_DRUMS) {
    for (const f of files) {
        const dest = join(SAMPLES, f.sub);
        mkdirSync(dirname(dest), {recursive: true});
        let src;
        if (f.fischer) src = join(FISCHER, f.fischer);
        else if (f.uzu) src = join(UZU, f.uzu);
        else continue;
        if (!existsSync(src)) {
            console.warn(`[vendor-core-drums] missing ${src}`);
            missing++;
            continue;
        }
        cpSync(src, dest);
        copied++;
    }
}
console.log(`[vendor-core-drums] copied ${copied} files, ${missing} missing`);
if (missing) process.exit(1);
