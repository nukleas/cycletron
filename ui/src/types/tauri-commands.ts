// Mirror of Rust `FileDoc`, `Frontmatter`, `CurrentFile`, `SessionSnapshot`.
// Regenerate by hand when the Rust types change.

export interface Frontmatter {
    name: string | null;
    bpm: number | null;
    tags: string[];
    created: string | null;
}

export interface FileDoc {
    path: string;
    code: string;
    frontmatter: Frontmatter | null;
}

export interface CurrentFile {
    path: string | null;
    name: string | null;
    dirty: boolean;
}

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: string;
}

export interface SessionSnapshot {
    file_path: string | null;
    code: string;
    bpm: number;
    messages: ChatMessage[];
    saved_at: string;
}

export interface CorpusEntry {
    id: string;
    filename: string;
    /** "strudel", "js-song", "tidal", "curated", etc. — lets the UI distinguish native strudel-rs mini-notation entries from ones authored for the full JS web-strudel runtime. */
    file_type: string | null;
    title: string | null;
    author: string | null;
    tempo: number | null;
    sounds: string[];
    effects: string[];
    scales: string[];
    tags: string[];
    features: string[];
    complexity: string | null;
    source_code: string | null;
}

export interface MidiImport {
    code: string;
    bpm: number;
    source_path: string;
}

export interface MidiTrackInfo {
    index: number;
    channel: number | null;
    program: number | null;
    name: string | null;
    note_count: number;
    is_drum: boolean;
}

export interface MidiMetadata {
    bpm: number;
    cycle_len: number;
    tracks: MidiTrackInfo[];
}

export interface AppInfo {
    name: string;
    version: string;
    identifier: string;
    tauri_version: string;
}

export interface Snapshot {
    id: string;
    created_at_ms: number;
    size: number;
}

export interface AnthropicOverrides {
    api_key: string | null;
    model: string | null;
    max_tokens: number | null;
}

export interface AudioOverrides {
    default_tempo: number | null;
}

export interface UpdaterSettings {
    auto_check: boolean;
}

export interface NotificationSettings {
    enabled: boolean;
}

export interface MetronomeSettings {
    enabled: boolean;
    volume: number;
}

export interface MidiInputSettings {
    device_id: string | null;
    cc_gain: number;
    cc_bpm: number;
}

export interface UserSettings {
    anthropic: AnthropicOverrides;
    audio: AudioOverrides;
    updater: UpdaterSettings;
    notifications: NotificationSettings;
    metronome: MetronomeSettings;
    midi_input: MidiInputSettings;
    first_run_done: boolean;
}

/// Mirror of `commands::ImportMidiOptions`. Keys are camelCase to match the
/// serde rename on the Rust side.
export interface ImportMidiOptions {
    notesPerBar?: number;
    autoResolution?: boolean;
    barLimit?: number;
    compact?: boolean;
    detectDrumNames?: boolean;
    instrumentMode?: 'hybrid' | 'waveforms' | 'gm' | 'auto';
    drumBank?: 'simple' | '808' | '909' | '707' | 'linn' | 'dmx' | 'auto';
    includedChannels?: number[];
}

export interface CorpusQuery {
    tags: string[];
    role: string | null;
    tempo_min: number | null;
    tempo_max: number | null;
    complexity: string | null;
    sounds: string[];
    keyword: string | null;
    limit: number | null;
}
