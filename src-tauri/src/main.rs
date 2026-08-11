#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Linux/WebKitGTK environment fixes. All must land before GTK/the webview
    // initializes.
    // SAFETY: called before any other threads are spawned.
    #[cfg(target_os = "linux")]
    unsafe {
        // WebKitGTK gates SharedArrayBuffer behind the JSC runtime option
        // `useSharedArrayBuffer` (read from the env as `JSC_<option>`) instead
        // of wiring it to COOP/COEP isolation the way browsers do — without it
        // the page reports crossOriginIsolated=true but the constructor never
        // exists and the audio engine can't start (#4).
        std::env::set_var("JSC_useSharedArrayBuffer", "1");

        // The AppImage's AppRun forces GDK_BACKEND=x11 — Tauri's workaround
        // for Wayland crashes that were really caused by the stale bundled
        // libwayland libs our release CI now strips (#6). XWayland adds a
        // presentation layer with poor frame pacing, which reads as UI jank
        // (#8), so prefer native Wayland whenever a compositor is present.
        // CYCLETRON_FORCE_X11=1 is the escape hatch for setups where Wayland
        // still misbehaves (e.g. old NVIDIA drivers).
        if std::env::var_os("WAYLAND_DISPLAY").is_some()
            && std::env::var_os("CYCLETRON_FORCE_X11").is_none()
        {
            std::env::set_var("GDK_BACKEND", "wayland");
        }

        // WebKitGTK 2.48+ hybrid Skia painting defaults to a CPU raster pool
        // that burns most of a core on our always-animating UI; 0 moves tile
        // painting to the GPU workers (#8). Respect an explicit user setting.
        if std::env::var_os("WEBKIT_SKIA_CPU_PAINTING_THREADS").is_none() {
            std::env::set_var("WEBKIT_SKIA_CPU_PAINTING_THREADS", "0");
        }
    };

    cycletron_app::run()
}
