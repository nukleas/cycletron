/**
 * LLM provider presets, shared by the Preferences and first-run Welcome modals.
 *
 * Each preset maps a user-facing choice (Claude, Grok, OpenAI, local, custom)
 * to a wire codec plus default base URL / model / token budget. API keys are
 * never stored here — they go through `set_provider_key` (dev: app-data file; release: keychain).
 * Mirrors the built-in presets in `src-tauri/src/settings.rs`.
 */

import type {LlmSettings, ProviderProfile} from './types/tauri-commands.js';

export interface ProviderPreset {
    id: string;
    label: string;
    /** "anthropic" (Messages API) or "openai" (OpenAI-compatible chat). */
    codec: 'anthropic' | 'openai';
    /** Default base URL for the OpenAI codec; null for the Anthropic codec. */
    baseUrl: string | null;
    model: string;
    maxTokens: number;
    keyPlaceholder: string;
    /** Whether this provider needs a key to work at all. */
    keyRequired: boolean;
    /** Base URL is only meaningful for the OpenAI codec. */
    showBaseUrl: boolean;
    note?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
    {
        id: 'anthropic', label: 'Claude (Anthropic)', codec: 'anthropic',
        baseUrl: null, model: 'claude-sonnet-4-6', maxTokens: 64000,
        keyPlaceholder: 'sk-ant-…', keyRequired: true, showBaseUrl: false,
    },
    {
        id: 'grok', label: 'Grok (xAI)', codec: 'openai',
        baseUrl: 'https://api.x.ai/v1', model: 'grok-4.5', maxTokens: 32000,
        keyPlaceholder: 'xai-…', keyRequired: true, showBaseUrl: true,
    },
    {
        id: 'openai', label: 'OpenAI', codec: 'openai',
        baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1', maxTokens: 16000,
        keyPlaceholder: 'sk-…', keyRequired: true, showBaseUrl: true,
    },
    {
        id: 'local', label: 'Local (Ollama / LM Studio)', codec: 'openai',
        baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', maxTokens: 8192,
        keyPlaceholder: '(usually not needed)', keyRequired: false, showBaseUrl: true,
        note: 'Local models often don’t support tool calling, so the AI may chat but not control audio.',
    },
    {
        id: 'custom', label: 'Custom (OpenAI-compatible)', codec: 'openai',
        baseUrl: '', model: '', maxTokens: 8192,
        keyPlaceholder: 'API key (if required)', keyRequired: false, showBaseUrl: true,
        note: 'Any OpenAI-compatible endpoint — set the base URL and model.',
    },
];

export function presetById(id: string): ProviderPreset | undefined {
    return PROVIDER_PRESETS.find((p) => p.id === id);
}

export function presetProfile(id: string): ProviderProfile {
    const p = presetById(id) ?? PROVIDER_PRESETS[0];
    return {codec: p.codec, base_url: p.baseUrl, model: p.model, max_tokens: p.maxTokens};
}

export function defaultLlmSettings(): LlmSettings {
    const providers: Record<string, ProviderProfile> = {};
    for (const p of PROVIDER_PRESETS) providers[p.id] = presetProfile(p.id);
    return {active: 'anthropic', providers};
}

/** Merge stored settings with defaults so every preset always has a profile. */
export function normalizeLlm(llm: LlmSettings | undefined | null): LlmSettings {
    const base = defaultLlmSettings();
    if (!llm) return base;
    const providers = {...base.providers, ...(llm.providers ?? {})};
    const active = llm.active && presetById(llm.active) ? llm.active : 'anthropic';
    return {active, providers};
}
