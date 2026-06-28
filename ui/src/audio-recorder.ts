/**
 * Live audio capture of the AudioContext mix into a WAV file.
 *
 * Pipeline: AnalyserNode (existing mix tap) → MediaStreamAudioDestinationNode
 * → MediaRecorder (browser-native codec) → on stop, decodeAudioData → encode
 * a proper PCM WAV → save via the Rust `write_binary_file` command.
 *
 * Auto-stop: if the user specifies "stop after N bars", we estimate the
 * duration from the current BPM and call `stop()` after that interval.
 */

import {invoke} from './tauri.js';
import {notify} from './notifications.js';
import {addTask, removeTask} from './dock-badge.js';

const isTauri = !!(window as any).__TAURI__;

type RecorderState = 'idle' | 'recording' | 'finalizing';

class AudioRecorder {
    private state: RecorderState = 'idle';
    private mediaRecorder: MediaRecorder | null = null;
    private streamDest: MediaStreamAudioDestinationNode | null = null;
    private chunks: Blob[] = [];
    private mimeType = 'audio/webm';
    private autoStopTimer: number | null = null;
    private startedAt = 0;

    private btn: HTMLButtonElement | null = null;
    private barsInput: HTMLInputElement | null = null;
    private statusEl: HTMLElement | null = null;

    init(): void {
        this.btn = document.getElementById('recordBtn') as HTMLButtonElement | null;
        this.barsInput = document.getElementById('recordBars') as HTMLInputElement | null;
        this.statusEl = document.getElementById('recordStatus');
        this.btn?.addEventListener('click', () => { void this.toggle(); });
        this.updateUi();
    }

    isRecording(): boolean {
        return this.state === 'recording';
    }

    async toggle(): Promise<void> {
        if (this.state === 'idle') await this.start();
        else if (this.state === 'recording') this.stop();
    }

    private async start(): Promise<void> {
        const app = window.strudelApp;
        const ctx = app?.audioManager?.getAudioContext?.();
        const analyser = app?.audioManager?.getAnalyser?.();
        if (!ctx || !analyser) {
            await this.warn('Audio is not initialised. Press Play first.');
            return;
        }
        const mime = pickSupportedMimeType();
        if (!mime) {
            await this.warn("Browser doesn't support audio recording.");
            return;
        }
        this.mimeType = mime;

        // Tap the analyser into a media-stream destination *in parallel*
        // with the live output — recording captures the mix without
        // disturbing playback.
        this.streamDest = ctx.createMediaStreamDestination();
        analyser.connect(this.streamDest);

        this.mediaRecorder = new MediaRecorder(this.streamDest.stream, {mimeType: mime});
        this.chunks = [];
        this.mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) this.chunks.push(e.data);
        };
        this.mediaRecorder.onstop = () => { void this.finalize(ctx); };

        this.state = 'recording';
        this.startedAt = performance.now();
        this.mediaRecorder.start(1000);
        this.updateUi();
        this.scheduleAutoStop();
        addTask('recording');
    }

    private stop(): void {
        if (this.autoStopTimer != null) {
            clearTimeout(this.autoStopTimer);
            this.autoStopTimer = null;
        }
        this.state = 'finalizing';
        this.updateUi();
        try {
            this.mediaRecorder?.stop();
        } catch (e) {
            console.warn('[recorder] stop failed:', e);
        }
    }

    private scheduleAutoStop(): void {
        const bars = parseFloat(this.barsInput?.value ?? '');
        if (!Number.isFinite(bars) || bars <= 0) return;
        const bpm = currentBpm();
        if (bpm <= 0) return;
        // Assume 4 beats per bar — matches Strudel's default cycle behaviour.
        const seconds = (bars * 4 * 60) / bpm;
        this.autoStopTimer = window.setTimeout(() => this.stop(), seconds * 1000);
    }

    private async finalize(ctx: AudioContext): Promise<void> {
        // Disconnect the tap so we stop accumulating samples.
        try {
            this.streamDest && window.strudelApp?.audioManager?.getAnalyser?.()?.disconnect(this.streamDest);
        } catch { /* ignore */ }
        this.streamDest = null;
        const recordedMs = performance.now() - this.startedAt;

        try {
            const blob = new Blob(this.chunks, {type: this.mimeType});
            this.chunks = [];
            if (blob.size === 0) {
                await this.warn('Nothing was recorded.');
                return;
            }
            const arrayBuffer = await blob.arrayBuffer();
            const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
            const wavBytes = encodeWav(audioBuffer);
            await this.promptAndSave(wavBytes, recordedMs / 1000);
        } catch (e: any) {
            console.error('[recorder] finalize failed:', e);
            await this.warn(`Could not finalise recording:\n${e}`);
        } finally {
            this.state = 'idle';
            this.updateUi();
            removeTask('recording');
        }
    }

    private async promptAndSave(bytes: Uint8Array, seconds: number): Promise<void> {
        if (!isTauri) {
            // Fallback: blob URL download (used only in browser dev).
            // Cast through `unknown` because Uint8Array's generic over
            // ArrayBufferLike confuses Blob's type signature in projects
            // that enable SharedArrayBuffer.
            const blob = new Blob([bytes as unknown as BlobPart], {type: 'audio/wav'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = defaultFileName();
            a.click();
            URL.revokeObjectURL(url);
            return;
        }
        const {save} = await import('@tauri-apps/plugin-dialog');
        const picked = await save({
            defaultPath: defaultFileName(),
            filters: [{name: 'WAV Audio', extensions: ['wav']}],
        });
        if (!picked) return;
        try {
            await invoke<void>('write_binary_file', {path: picked, bytes: Array.from(bytes)});
            const niceDuration = seconds.toFixed(1);
            this.flash(`Saved (${niceDuration}s)`);
            void notify('Recording saved', `${basename(picked)} · ${niceDuration}s`);
        } catch (e: any) {
            await this.warn(`Could not save:\n${e}`);
        }
    }

    private updateUi(): void {
        if (this.btn) {
            this.btn.classList.toggle('is-recording', this.state === 'recording');
            this.btn.disabled = this.state === 'finalizing';
            const label = this.btn.querySelector('.btn-text');
            if (label) {
                label.textContent =
                    this.state === 'recording' ? 'Stop' :
                    this.state === 'finalizing' ? 'Saving…' : 'Rec';
            }
        }
        if (this.statusEl) {
            this.statusEl.textContent = this.state === 'recording' ? '● REC' : '';
        }
    }

    private flash(text: string): void {
        if (!this.statusEl) return;
        const el = this.statusEl;
        const prev = el.textContent;
        el.textContent = text;
        setTimeout(() => { if (el.textContent === text) el.textContent = prev ?? ''; }, 2000);
    }

    private async warn(message: string): Promise<void> {
        if (!isTauri) { console.warn(message); return; }
        try {
            const {message: dialog} = await import('@tauri-apps/plugin-dialog');
            await dialog(message, {title: 'Robostrudel', kind: 'warning'});
        } catch { /* ignore */ }
    }
}

// ------------------------------------------------------------------
// WAV encoding (PCM Int16, interleaved)
// ------------------------------------------------------------------

function encodeWav(buffer: AudioBuffer): Uint8Array {
    const channels = buffer.numberOfChannels;
    const length = buffer.length;
    const sampleRate = buffer.sampleRate;
    // 16-bit PCM, interleaved.
    const dataLen = length * channels * 2;
    const out = new ArrayBuffer(44 + dataLen);
    const view = new DataView(out);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataLen, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);          // PCM chunk size
    view.setUint16(20, 1, true);            // format = PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);           // bits per sample
    writeString(view, 36, 'data');
    view.setUint32(40, dataLen, true);

    // Pull channel data once to avoid repeated calls in the inner loop.
    const channelData: Float32Array[] = [];
    for (let c = 0; c < channels; c++) channelData.push(buffer.getChannelData(c));

    let offset = 44;
    for (let i = 0; i < length; i++) {
        for (let c = 0; c < channels; c++) {
            const sample = Math.max(-1, Math.min(1, channelData[c][i]));
            const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
            view.setInt16(offset, int16, true);
            offset += 2;
        }
    }
    return new Uint8Array(out);
}

function writeString(view: DataView, offset: number, str: string): void {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function pickSupportedMimeType(): string | null {
    const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
    ];
    for (const m of candidates) {
        try {
            if (MediaRecorder.isTypeSupported(m)) return m;
        } catch { /* ignore */ }
    }
    return null;
}

function currentBpm(): number {
    const el = document.getElementById('bpmSlider') as HTMLInputElement | null;
    const v = el ? parseFloat(el.value) : NaN;
    return Number.isFinite(v) ? v : 120;
}

function defaultFileName(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `robostrudel-${stamp}.wav`;
}

function basename(path: string): string {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || path;
}

export const audioRecorder = new AudioRecorder();
(window as any).audioRecorder = audioRecorder;
