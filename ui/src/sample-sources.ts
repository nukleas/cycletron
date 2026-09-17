/**
 * Where to find more samples.
 *
 * TypeScript, not Rust, on purpose: this is presentational copy with no backend
 * consumer, and it must stay out of the agent's sound catalog — the model
 * cannot download anything or accept anyone's terms on the user's behalf.
 *
 * `license` quotes or paraphrases **the publisher's own stated terms**. It is
 * never our reading of what a user is allowed to do. Cycletron links to these
 * sites; it does not host, mirror, or license any of the audio, and an imported
 * pack is recorded as `LicenseRef-UserProvided` — a marker meaning "the user
 * supplied this", not a grant.
 */

export interface SampleSource {
    id: string;
    name: string;
    /** One line: what you actually get. */
    blurb: string;
    url: string;
    /** The upstream terms, as stated upstream. */
    license: string;
    /** What the download looks like, so the import path is no surprise. */
    format: string;
}

export const FREE_SAMPLE_SOURCES: readonly SampleSource[] = [
    {
        id: 'legowelt',
        name: 'Legowelt',
        blurb:
            "Danny Wolfers' own hardware: Jupiter 8, Juno 106, Mono/Poly, JD 800, " +
            'Prophet 600, DX synths, and a 325-piece drum pack.',
        url: 'https://legowelt.org/samples/',
        license:
            'Stated terms: “The samples are free to download and use in your productions.” ' +
            'No redistribution grant and no SPDX identifier.',
        format: 'ZIP of 16-bit WAVs, via WeTransfer links that expire — reload the page for a fresh one.',
    },
    {
        id: 'freesound',
        name: 'Freesound',
        blurb: 'Community field recordings, one-shots and loops, searchable by licence.',
        url: 'https://freesound.org/',
        license:
            'Per sound: CC0, CC-BY, CC-BY-NC or Sampling+. Check each sound — attribution is often required.',
        format: 'Individual files or curated packs; account required to download.',
    },
    {
        id: 'archive-org',
        name: 'Internet Archive',
        blurb: 'Sample CDs, breaks collections and archived sound libraries.',
        url: 'https://archive.org/details/audio',
        license: 'Per item: public domain, Creative Commons, or all rights reserved. Check the item page.',
        format: 'ZIP or individual files, depending on the item.',
    },
    {
        id: 'vcsl',
        name: 'Versilian Community Sample Library',
        blurb: 'Orchestral and world instruments, 128 banks.',
        url: 'https://github.com/sgossner/VCSL',
        license: 'CC0-1.0 (public domain dedication).',
        format: 'Already built in — activate the “vcsl” sample set instead of importing it.',
    },
    {
        id: 'sampleradar',
        name: 'MusicRadar SampleRadar',
        blurb: 'Several thousand free packs: drums, synths, loops, by genre.',
        url: 'https://www.musicradar.com/news/tech/free-music-samples-royalty-free-loops-hits-and-multis-635408',
        license: 'MusicRadar states the samples are free to use, including in commercial productions.',
        format: 'ZIP of WAVs per pack.',
    },
    {
        id: '99sounds',
        name: '99Sounds',
        blurb: 'Curated free packs — drums, textures, foley, cinematic hits.',
        url: 'https://99sounds.org/',
        license:
            'Stated as royalty-free for music production; redistributing the sample files themselves is not permitted.',
        format: 'ZIP of WAVs per pack.',
    },
];
