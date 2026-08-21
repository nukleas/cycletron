mod agent_loop;
mod codex_oauth;
mod commands;
mod demos;
mod export;
mod files;
mod library;
mod library_index;
mod logs;
mod menu;
mod midi_input;
mod oauth;
mod oauth_store;
mod packs;
mod persistence;
mod sample_sets;
mod secrets;
mod settings;
mod shortcuts;
mod snapshots;
mod sounds;
mod state;
mod telemetry;
mod tray;
mod xai_oauth;

use state::AppState;
use tauri::Manager;
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tracing_subscriber::EnvFilter;
use tracing_subscriber::layer::SubscriberExt as _;
use tracing_subscriber::util::SubscriberInitExt as _;

// Production-only: embed `ui/dist` and serve it over localhost with COOP/COEP
// so WebKit grants SharedArrayBuffer. Dev builds talk to Vite instead, so we
// do not require `ui/dist` (or npm install) just to compile `cargo tauri dev`.
#[cfg(not(debug_assertions))]
mod production_frontend {
    use http_body_util::Full;
    use hyper::body::Bytes;
    use hyper::server::conn::http1;
    use hyper::service::service_fn;
    use hyper::{Request, Response, StatusCode};
    use hyper_util::rt::TokioIo;
    use rust_embed::Embed;
    use tauri::async_runtime;
    use tokio::net::TcpListener;

    /// Embeds the production frontend (`ui/dist`) at compile time.
    /// Built by `beforeBuildCommand` (`npm run build`) before release compiles.
    #[derive(Embed)]
    #[folder = "$CARGO_MANIFEST_DIR/../ui/dist"]
    struct FrontendAssets;

    /// Minimal HTTP server on a random localhost port that always sets the
    /// headers required for SharedArrayBuffer.
    pub async fn start_local_frontend_server() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("failed to bind local frontend server");
        let port = listener.local_addr().unwrap().port();

        async_runtime::spawn(async move {
            loop {
                let (stream, _) = match listener.accept().await {
                    Ok(s) => s,
                    Err(e) => {
                        tracing::error!("frontend server accept error: {e}");
                        continue;
                    }
                };

                let io = TokioIo::new(stream);

                async_runtime::spawn(async move {
                    let service = service_fn(|req: Request<hyper::body::Incoming>| async move {
                        serve_embedded_asset(req).await
                    });

                    if let Err(err) = http1::Builder::new().serve_connection(io, service).await {
                        tracing::debug!("frontend server connection error: {err}");
                    }
                });
            }
        });

        port
    }

    async fn serve_embedded_asset(
        req: Request<hyper::body::Incoming>,
    ) -> Result<Response<Full<Bytes>>, hyper::Error> {
        let path = req.uri().path().trim_start_matches('/');

        // Default to index.html for SPA-style routing
        let file_path = if path.is_empty() || path == "index.html" {
            "index.html"
        } else {
            path
        };

        let file = FrontendAssets::get(file_path);

        let response = if let Some(content) = file {
            let mime = mime_guess::from_path(file_path).first_or_octet_stream();

            Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", mime.as_ref())
                .header("Cross-Origin-Opener-Policy", "same-origin")
                .header("Cross-Origin-Embedder-Policy", "require-corp")
                .header("Cross-Origin-Resource-Policy", "same-origin")
                .body(Full::from(Bytes::from(content.data.into_owned())))
                .unwrap()
        } else {
            Response::builder()
                .status(StatusCode::NOT_FOUND)
                .header("Cross-Origin-Opener-Policy", "same-origin")
                .header("Cross-Origin-Embedder-Policy", "require-corp")
                .header("Cross-Origin-Resource-Policy", "same-origin")
                .body(Full::from(Bytes::from_static(b"Not Found")))
                .unwrap()
        };

        Ok(response)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Compose two layers: stderr fmt for dev, and a bounded ring buffer
    // so the in-app Logs modal can show recent activity without reaching
    // out to the OS log facility.
    let filter = EnvFilter::from_default_env().add_directive("cycletron=debug".parse().unwrap());
    let fmt_layer = tracing_subscriber::fmt::layer().with_writer(std::io::stderr);
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt_layer)
        .with(logs::InMemoryLayer)
        .init();

    // Must run before the updater can move the live bundle aside — see
    // commands::relaunch_app.
    commands::capture_installed_app_path();

    let app_state = AppState::new();

    tauri::Builder::default()
        // Single-instance must be registered before any other plugin so a
        // second launch (e.g. opening a file from Finder) is short-circuited
        // and its argv forwarded to the existing window.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            crate::commands::handle_second_instance(app, args);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(app_state)
        .manage(tray::TrayStateHolder::new())
        .manage(midi_input::MidiInputState::new())
        .setup(|app| {
            // Resolve the app data dir (e.g. ~/Library/Application Support/com.nukleas.cycletron)
            // and hand it to AppState so recents + session snapshots can persist.
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("cycletron"));
            if let Err(e) = std::fs::create_dir_all(&data_dir) {
                tracing::warn!("could not create app data dir {}: {e}", data_dir.display());
            }

            let state = app.state::<AppState>();
            if let Err(e) = state.initialize(data_dir) {
                tracing::error!("initialization failed: {e}");
            }

            // Seed the strudel sample-set bank names for the agent's sound
            // catalog (no-op when the set isn't downloaded).
            sample_sets::refresh_bank_names(app.handle());

            // Native menu — emits `menu:<action>` events consumed by the frontend.
            let recents = app.state::<AppState>().recents.lock().entries.clone();
            let menu = menu::build_app_menu(app.handle(), &recents)?;
            app.set_menu(menu)?;
            let handle = app.handle().clone();
            app.on_menu_event(move |_window, event| {
                menu::handle_menu_event(&handle, event);
            });

            // System tray — playback transport + show/quit.
            match tray::build_tray(app.handle()) {
                Ok(tray_state) => {
                    let holder = app.state::<tray::TrayStateHolder>();
                    *holder.play_pause.lock() = Some(tray_state.play_pause_item);
                }
                Err(e) => tracing::warn!("tray setup failed: {e}"),
            }

            // System-wide shortcuts (Cmd+Shift+Space, etc.).
            if let Err(e) = shortcuts::register_defaults(app.handle()) {
                tracing::warn!("global shortcuts setup failed: {e}");
            }

            // External-change watcher: emits `file-externally-changed`
            // whenever the current session file's mtime changes on disk.
            commands::spawn_external_change_watcher(app.handle().clone());

            // === Proper fix for SharedArrayBuffer in production ===
            // On macOS WKWebView, the `tauri://localhost` scheme does not expose
            // SharedArrayBuffer/Atomics even with COOP/COEP headers.
            //
            // Solution: In release builds we serve the embedded frontend over a
            // real `http://127.0.0.1` origin (with the three required headers
            // injected on every response). This makes WebKit grant full SAB support.
            //
            // In debug builds we keep pointing at the Vite dev server (fast HMR).
            #[cfg(debug_assertions)]
            let main_window = {
                // Dev: use Vite dev server (headers already set in vite.config.ts)
                WebviewWindowBuilder::new(
                    app,
                    "main",
                    WebviewUrl::External(
                        app.config()
                            .build
                            .dev_url
                            .clone()
                            .expect("devUrl must be set for debug builds")
                            .to_string()
                            .parse()
                            .unwrap(),
                    ),
                )
                .title("Cycletron")
                .inner_size(1400.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .resizable(true)
                .build()?
            };
            #[cfg(not(debug_assertions))]
            let main_window = {
                // Production: localhost HTTP server with COOP/COEP + CORP headers.
                // block_on because setup() is synchronous.
                let port = tauri::async_runtime::block_on(
                    production_frontend::start_local_frontend_server(),
                );
                let url = format!("http://127.0.0.1:{}/index.html", port);

                tracing::info!("Production frontend served at {}", url);

                WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                    .title("Cycletron")
                    .inner_size(1400.0, 900.0)
                    .min_inner_size(900.0, 600.0)
                    .resizable(true)
                    .build()?
            };

            // Keep a reference so the window doesn't get dropped immediately.
            // (Tauri keeps windows alive as long as the handle exists.)
            std::mem::forget(main_window);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::send_message,
            commands::validate_pattern,
            commands::updater_install_kind,
            commands::relaunch_app,
            commands::inspect_pattern,
            commands::analyze_arrangement,
            commands::detect_pattern_length,
            commands::critique_pattern,
            commands::critique_form,
            commands::genre_recipe,
            commands::reload_corpus,
            commands::get_pattern_history,
            commands::get_config,
            commands::clear_session,
            commands::open_file,
            commands::save_current,
            commands::save_as,
            commands::new_file,
            commands::is_dirty,
            commands::get_current_file,
            commands::get_recents,
            commands::clear_recents,
            commands::session_undo,
            commands::session_redo,
            commands::get_library_root,
            commands::set_library_root,
            commands::list_library,
            commands::create_library_folder,
            commands::create_library_file,
            commands::delete_library_path,
            commands::rename_library_path,
            commands::reveal_in_os,
            persistence::autosave_session,
            persistence::restore_session,
            tray::tray_set_playback,
            commands::import_midi,
            commands::inspect_midi,
            commands::save_midi_to_library,
            commands::get_user_settings,
            commands::set_user_settings,
            commands::set_provider_key,
            commands::has_provider_key,
            commands::xai_oauth_status,
            commands::xai_oauth_import_grok_build,
            commands::xai_oauth_start_login,
            commands::xai_oauth_poll_login,
            commands::xai_oauth_logout,
            commands::codex_oauth_status,
            commands::codex_oauth_import_cli,
            commands::codex_oauth_login,
            commands::codex_oauth_logout,
            commands::get_app_info,
            commands::write_binary_file,
            commands::export_audio,
            commands::export_midi,
            commands::list_snapshots,
            commands::read_snapshot,
            commands::get_logs,
            commands::clear_logs,
            commands::log_diagnostic,
            commands::diagnostic_dump,
            commands::set_dock_badge,
            sounds::scan_sample_folder,
            sounds::read_audio_file,
            sounds::register_sound_banks,
            sounds::list_sounds,
            sample_sets::list_sample_sets,
            sample_sets::download_sample_set,
            sample_sets::remove_sample_set,
            sample_sets::get_active_sample_set_manifests,
            packs::list_packs,
            packs::enable_pack,
            packs::disable_pack,
            packs::load_enabled_packs,
            packs::packs_dir,
            packs::install_pack_from_folder,
            midi_input::list_midi_input_devices,
            midi_input::start_midi_input_listening,
            midi_input::stop_midi_input_listening,
            midi_input::get_midi_input_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
