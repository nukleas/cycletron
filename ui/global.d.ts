// noinspection JSUnusedGlobalSymbols
interface Window {
    __savedEditorCode: string | null;
    strudelApp: import('./src/app.js').StrudelApp;
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
