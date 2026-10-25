/**
 * Release notes from CHANGELOG.md, bundled at build time so What's New works
 * offline and for package-manager installs that never see latest.json.
 */

import changelog from '../../CHANGELOG.md?raw';

export interface Release {
    /** Version as written in the heading, e.g. `0.1.0-alpha.25` or `Unreleased`. */
    version: string;
    /** The release's markdown, heading included. */
    body: string;
}

/** `## <version> (<date>)`; releases are listed newest first. */
const RELEASE_HEADING = /^## (\S+)/;

function parse(text: string): Release[] {
    // Split before each release heading; the first chunk is the file's intro.
    return text.split(/^(?=## )/m).slice(1).map(chunk => ({
        version: RELEASE_HEADING.exec(chunk)![1],
        body: chunk.trim(),
    }));
}

const RELEASES = parse(changelog);

/** Every shipped release (Unreleased left out), newest first. */
export function shippedReleases(): Release[] {
    return RELEASES.filter(r => r.version !== 'Unreleased');
}

/**
 * Releases after `since`, up to and including `current`. With no `since`, or
 * one the changelog doesn't list, just `current`. Empty when `current` isn't
 * listed (a dev build) or `since` is newer (a downgrade).
 */
export function releasesSince(since: string | null, current: string): Release[] {
    const shipped = shippedReleases();
    const end = shipped.findIndex(r => r.version === current);
    if (end < 0) return [];
    const start = since == null ? -1 : shipped.findIndex(r => r.version === since);
    if (start < 0) return [shipped[end]];
    return shipped.slice(end, start);
}

/** Releases joined back into one markdown document. */
export function releasesToMarkdown(releases: Release[]): string {
    return releases.map(r => r.body).join('\n\n');
}
