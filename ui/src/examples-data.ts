// Example catalog. Every entry is sourced from on-disk `.strudel` files so the
// browser stays in lockstep with `corpus/` and `ui/songs/`, and every snippet
// is gated by `corpus-check` against the real strudel-rs surface — nothing here
// can silently drift into syntax the engine rejects.

import {
    loadGenreExamples,
    loadLessonExamples,
    loadPatternExamples,
    loadShowcaseExamples,
    loadSongExamples,
    loadTechniqueExamples,
} from './examples-from-files.js';

export type ExampleSection =
    | 'lessons'
    | 'patterns'
    | 'showcase'
    | 'techniques'
    | 'songs'
    | 'genres';

export interface Example {
    title: string;
    code: string;
    tags: string[];
    complexity: string;
    tempo: number | null;
    section: ExampleSection;
    /** Lesson order (1-based) when section === 'lessons' */
    lesson?: number;
    blurb?: string;
}

/** Full catalog: progressive teaching set + every bundled song/technique/genre. */
export const EXAMPLES: Example[] = [
    ...loadLessonExamples(),
    ...loadPatternExamples(),
    ...loadShowcaseExamples(),
    ...loadTechniqueExamples(),
    ...loadSongExamples(),
    ...loadGenreExamples(),
];

export const SECTION_LABELS: Record<ExampleSection, string> = {
    lessons: 'Lessons',
    patterns: 'Patterns',
    showcase: 'Showcase',
    techniques: 'Techniques',
    songs: 'Songs & albums',
    genres: 'Genres',
};

export const SECTION_ORDER: ExampleSection[] = [
    'lessons',
    'patterns',
    'showcase',
    'techniques',
    'songs',
    'genres',
];
