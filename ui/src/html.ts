/**
 * Shared HTML helpers. Centralizing escaping means any future hardening
 * (e.g. escaping quotes for attribute contexts) lands in one place.
 */
export function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
