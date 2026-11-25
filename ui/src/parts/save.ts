/**
 * Save a voice from the open song as a part in the library.
 *
 * Parts live in `<library>/Parts/<role>/<name>.strudel`. The folder is the
 * role, so moving a file between folders moves it between groups on the shelf.
 */

import {invoke, isTauri} from '../tauri.js';
import {basename} from '../paths.js';
import {currentBpm} from '../bpm.js';
import {errorDialog, infoDialog, saveFileDialog} from '../dialog.js';
import {parseTracks, type MixTrack} from '../mixer.js';
import {PARTS_DIR} from './catalog.js';
import {classify, tempoOf} from './split.js';

/** The selection if there is one, else the track the cursor is in. */
export async function saveSelectionAsPart(): Promise<void> {
    const editor = window.strudelApp?.editor;
    if (!editor) return;
    const code = editor.getCode();
    const sel = editor.view.state.selection.main;

    if (!sel.empty) {
        await savePart(code, code.slice(sel.from, sel.to), '');
        return;
    }
    const track = parseTracks(code).find((t) => sel.head >= t.start && sel.head <= t.end);
    if (!track) {
        await infoDialog('Select the code to save, or put the cursor in a $: track.');
        return;
    }
    await saveTrackAsPart(track);
}

export async function saveTrackAsPart(track: MixTrack): Promise<void> {
    const code = window.strudelApp?.editor?.getCode();
    if (code === undefined) return;
    await savePart(code, code.slice(track.start, track.end), track.label);
}

async function savePart(song: string, raw: string, label: string): Promise<void> {
    if (!isTauri) return;
    const body = raw.trim().replace(/^\$:\s*/, '').replace(/;$/, '');
    if (!body) return;

    const role = classify(label, body);
    const root = await invoke<string>('get_library_root');
    const dir = `${root}/${PARTS_DIR}/${role}`;
    // Fails when the folder is already there, which is fine.
    await invoke('create_library_folder', {path: dir}).catch(() => {});

    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'part';
    const path = await saveFileDialog({
        defaultPath: `${dir}/${slug}.strudel`,
        filters: [{name: 'Strudel', extensions: ['strudel']}],
    });
    if (!path) return;

    const name = basename(path).replace(/\.strudel$/i, '');
    const bpm = tempoOf(song) ?? currentBpm();
    const text = `// ${name}\nsetbpm(${bpm});\n\n${body}\n`;
    try {
        // The save dialog already asked before replacing a file.
        await invoke('delete_library_path', {path}).catch(() => {});
        await invoke('create_library_file', {path, bpm: null, text});
    } catch (e) {
        await errorDialog(`Could not save the part:\n${e}`);
    }
}
