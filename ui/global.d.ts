// noinspection JSUnusedGlobalSymbols
interface Window {
    __savedEditorCode: string | null;
    strudelApp: import('./src/app.js').StrudelApp;
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
