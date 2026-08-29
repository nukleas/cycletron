// noinspection JSUnusedGlobalSymbols

/** The subset of the Tauri browser global the frontend actually touches.
 *  Injected by the Tauri shell; absent in a plain browser (hence optional). */
interface TauriGlobal {
    core: {
        /** `args` may be a raw ArrayBufferView, which Tauri passes through as a
         *  binary body rather than JSON; `options.headers` carries the scalars. */
        invoke<T = unknown>(
            cmd: string,
            args?: Record<string, unknown> | ArrayBufferView,
            options?: {headers?: Record<string, string>},
        ): Promise<T>;
    };
    event: {
        listen<T = unknown>(event: string, handler: (event: {payload: T}) => void): Promise<() => void>;
        emit(event: string, payload?: unknown): Promise<void>;
    };
}

interface Window {
    __TAURI__?: TauriGlobal;
    __savedEditorCode: string | null;

    /** Set at the end of boot; `undefined` until then — every reader guards it. */
    strudelApp?: import('./src/app.js').StrudelApp;

    // Module singletons parked on `window` for devtools/console access only.
    // They are written once at module load and never read back through
    // `window`, but typing them keeps those writes off `(window as any)`.
    aboutModal: typeof import('./src/about-modal.js').aboutModal;
    audioRecorder: typeof import('./src/audio-recorder.js').audioRecorder;
    commandPalette: typeof import('./src/command-palette.js').commandPalette;
    fileExplorer: typeof import('./src/file-explorer.js').fileExplorer;
    fileManager: typeof import('./src/file-manager.js').fileManager;
    helpModal: typeof import('./src/help-modal.js').helpModal;
    historyModal: typeof import('./src/history-modal.js').historyModal;
    logsModal: typeof import('./src/logs-modal.js').logsModal;
    metronome: typeof import('./src/metronome.js').metronome;
    midiCapture: typeof import('./src/midi-capture.js').midiCapture;
    midiInput: typeof import('./src/midi-input.js').midiInput;
    midiLab: typeof import('./src/midi-lab.js').midiLab;
    midiMonitor: typeof import('./src/midi-monitor.js').midiMonitor;
    midiPads: typeof import('./src/midi-pads.js').midiPads;
    preferencesModal: typeof import('./src/preferences.js').preferencesModal;
    stage: typeof import('./src/stage.js').stage;
    welcomeModal: typeof import('./src/welcome-modal.js').welcomeModal;
}

interface ImportMeta {
    /** Vite's eager/lazy file glob. */
    glob: (
        pattern: string | string[],
        options?: {
            query?: string;
            import?: string;
            eager?: boolean;
            as?: string;
        },
    ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

declare module '*?raw' {
    const content: string;
    export default content;
}

declare module '*?url' {
    const url: string;
    export default url;
}

declare module '*?worker&url' {
    const url: string;
    export default url;
}
