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

export interface CleanupReport {
    notes_before: number;
    notes_after: number;
    removed_short: number;
    removed_duplicates: number;
    velocity_adjusted: number;
}

export interface MidiImport {
    code: string;
    bpm: number;
    source_path: string;
    cleanup: CleanupReport;
}

export interface MidiTrackInfo {
    index: number;
    channel: number | null;
    program: number | null;
    name: string | null;
    note_count: number;
    is_drum: boolean;
    pitch_min: number | null;
    pitch_max: number | null;
}

export interface MidiMetadata {
    bpm: number;
    cycle_len: number;
    tracks: MidiTrackInfo[];
    duration_secs: number;
    note_count: number;
    pitch_min: number | null;
    pitch_max: number | null;
    pitch_range_label: string;
    max_polyphony: number;
    channel_count: number;
    programs: number[];
}

export interface AppInfo {
    name: string;
    version: string;
    identifier: string;
    tauri_version: string;
}

/** Result of offline `export_audio` (WAV/MP3/stems via OfflineRenderer). */
export interface ExportAudioResult {
    paths: string[];
    stem_paths: string[];
    duration_secs: number;
    bpm: number;
    sample_rate: number;
    clipped_samples: number;
    notes: string[];
}

/** @deprecated alias — prefer ExportAudioResult */
export type ExportWavResult = ExportAudioResult;

/** Result of `export_midi` (strudio to-midi path). */
export interface ExportMidiResult {
    path: string;
    cycles: number;
    bpm: number;
    note_count: number;
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

/** One provider's settings. The API key lives in the secrets store, not here. */
export interface ProviderProfile {
    /** Wire codec: "anthropic" or "openai" (OpenAI-compatible). */
    codec: string;
    /** Base URL for OpenAI-compatible providers; null for the Anthropic codec. */
    base_url: string | null;
    model: string;
    max_tokens: number;
}

/** Multi-provider LLM config: active provider id + per-provider profiles. */
export interface LlmSettings {
    active: string;
    providers: Record<string, ProviderProfile>;
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

/** Which sample set live playback + export resolve sounds from — a set id
 *  from the `sample_sets` registry ('cycletron' = bundled default). */
export interface SampleSetSettings {
    active: string;
}

/** Mirror of `sample_sets::SetStatus` (one registry entry + download state). */
export interface SampleSetStatus {
    id: string;
    label: string;
    /** One line: what the set adds and under what license. */
    description: string;
    builtin: boolean;
    ready: boolean;
    files: number;
    bytes: number;
    /** Manifest sources in precedence order (first manifest owning a bank wins). */
    sources: string[];
}

/** Payload of the `sample-set-progress` event. */
export interface SampleSetProgress {
    set: string;
    source: string;
    done: number;
    total: number;
}

/** One source of the active downloaded set (`get_active_sample_set_manifests`). */
export interface SampleSourceManifest {
    id: string;
    /** Directory the manifest's relative paths resolve against. */
    dir: string;
    /** strudel.json contents: bank → files (array), note-map, or single path. */
    manifest: Record<string, string | string[] | Record<string, string>>;
}

export interface EditorSettings {
    assist_enabled: boolean;
}

export interface MidiDeviceInfo {
    id: string;
    name: string;
}

export interface PadTrigger {
    /// "cc" or "note".
    kind: 'cc' | 'note';
    /// CC number or note number.
    value: number;
}

export interface PadAssignment {
    trigger: PadTrigger;
    /// Action id, e.g. "togglePlay", "stop", "hush", "evaluate", "commit", "clear", "newTrack".
    action: string;
}

export interface MidiInputSettings {
    device_id: string | null;
    cc_gain: number;
    cc_bpm: number;
    monitor_enabled: boolean;
    monitor_instrument: string;
    monitor_gain: number;
    pad_assignments: PadAssignment[];
}

export interface UserSettings {
    llm: LlmSettings;
    /** Legacy single-provider block; migrated into `llm` + secrets store on launch. */
    anthropic: AnthropicOverrides;
    audio: AudioOverrides;
    updater: UpdaterSettings;
    notifications: NotificationSettings;
    metronome: MetronomeSettings;
    editor: EditorSettings;
    midi_input: MidiInputSettings;
    samples: SampleSetSettings;
    follow_desktop_theme: boolean;
    first_run_done: boolean;
    /** User has explicitly turned the AI assistant on. Off by default. */
    ai_consent: boolean;
}

/// Mirror of `commands::ImportMidiOptions`. Keys are camelCase to match the
/// serde rename on the Rust side.
export interface ImportMidiOptions {
    notesPerBar?: number;
    autoResolution?: boolean;
    barLimit?: number;
    compact?: boolean;
    compose?: boolean;
    sectionNaming?: 'heuristic' | 'generic';
    detectDrumNames?: boolean;
    instrumentMode?: 'hybrid' | 'waveforms' | 'gm' | 'auto';
    drumBank?: 'simple' | '808' | '909' | '707' | 'linn' | 'dmx' | 'auto';
    includedChannels?: number[];
    /** Master cleanup switch. false disables all cleanup knobs. Default true. */
    cleanup?: boolean;
    /** Drop notes shorter than 1/N of a quarter. 0 = off. */
    shortNoteDivisor?: number;
    removeDuplicates?: boolean;
    velocityMode?: 'off' | 'moderate' | 'strong';
}
