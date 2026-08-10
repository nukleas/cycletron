#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK gates SharedArrayBuffer behind the JSC runtime option
    // `useSharedArrayBuffer` (read from the env as `JSC_<option>`) instead of
    // wiring it to COOP/COEP isolation the way browsers do — without it the
    // page reports crossOriginIsolated=true but the constructor never exists
    // and the audio engine can't start. Must be set before the webview/JSC
    // initializes.
    #[cfg(target_os = "linux")]
    // SAFETY: called before any other threads are spawned.
    unsafe {
        std::env::set_var("JSC_useSharedArrayBuffer", "1")
    };

    cycletron_app::run()
}
