#!/usr/bin/env node
/**
 * Convert the TR-8 kits in `ui/sample-tables.ts` (TR8_KITS) into
 * `ui/public/machines/`. Source is MckAudio/MckSamplePacks (CC0); each take is
 * trimmed of leading and trailing silence, peak-normalised to −3 dB and
 * written as mono 16-bit 44.1 kHz WAV. Needs `sox` on PATH.
 *
 *   git clone --depth 1 --filter=blob:none --sparse https://github.com/MckAudio/MckSamplePacks.git /tmp/mck
 *   git -C /tmp/mck sparse-checkout set TR8
 *   node ui/scripts/vendor-tr8.mjs
 */
import {execFileSync} from 'node:child_process';
import {existsSync, statSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {TR8_KITS, takeIndex, tr8Url} from '../sample-tables.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(HERE, '../public');
const TR8 = join(process.env.MCK_SAMPLE_PACKS || '/tmp/mck', 'TR8');

let bytes = 0;
let count = 0;
for (const [machine, , takes] of TR8_KITS) {
    takes.forEach(([voice, src], i) => {
        const from = join(TR8, src);
        if (!existsSync(from)) throw new Error(`missing ${from}`);
        const to = join(PUBLIC, tr8Url(machine, voice, takeIndex(takes, i)));
        execFileSync('sox', ['-q', from, '-b', '16', '-r', '44100', '-c', '1', to,
            'silence', '1', '0.001', '-60d',
            // Trim the tail the same way from the reversed audio, with a 10 ms fade-out.
            'reverse', 'silence', '1', '0.01', '-60d', 'fade', 't', '0.01', 'reverse',
            'norm', '-3']);
        bytes += statSync(to).size;
        count++;
    });
}
console.log(`[vendor-tr8] wrote ${count} files, ${(bytes / 1e6).toFixed(2)} MB`);
