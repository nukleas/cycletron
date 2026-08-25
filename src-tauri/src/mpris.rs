//! MPRIS presence on Linux.
//!
//! One D-Bus name buys the whole desktop: media keys, the GNOME/KDE
//! now-playing popovers, waybar, and Omarchy's media bar widget all speak
//! MPRIS and none of them need to know what Cycletron is. Commands arriving
//! this way become the same `transport:*` events the tray and CLI emit.
//!
//! `mpris_server::Player` is `Rc`-backed and so cannot cross threads, which is
//! why it lives on a thread of its own with a current-thread runtime and takes
//! its updates through a channel.

use crate::playback::{PlaybackSnapshot, topic};
use mpris_server::{Metadata, PlaybackStatus, Player, TrackId};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

static TX: OnceLock<UnboundedSender<PlaybackSnapshot>> = OnceLock::new();

/// We never expose a track list, so one fixed id covers every pattern.
const TRACK_ID: &str = "/com/nukleas/cycletron/track/0";

/// Start the MPRIS server. Failure is not fatal — a session without a D-Bus
/// bus simply has no media integration, and Cycletron plays on regardless.
pub fn init(app: AppHandle) {
    let (tx, rx) = unbounded_channel();
    if TX.set(tx).is_err() {
        return;
    }

    let spawned = std::thread::Builder::new()
        .name("mpris".to_string())
        .spawn(move || match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => {
                let local = tokio::task::LocalSet::new();
                local.block_on(&rt, serve(app, rx));
            }
            Err(e) => tracing::warn!("could not start the MPRIS runtime: {e}"),
        });

    if let Err(e) = spawned {
        tracing::warn!("could not start the MPRIS thread: {e}");
    }
}

/// Report new transport state to the desktop. A no-op before `init`.
pub fn update(snapshot: &PlaybackSnapshot) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(snapshot.clone());
    }
}

async fn serve(app: AppHandle, mut rx: UnboundedReceiver<PlaybackSnapshot>) {
    let player = match Player::builder("cycletron")
        .identity("Cycletron")
        .desktop_entry("Cycletron")
        .can_play(true)
        .can_pause(true)
        .can_control(true)
        .can_raise(true)
        // A live-coded pattern has no track list and no seekable timeline.
        .can_go_next(false)
        .can_go_previous(false)
        .can_seek(false)
        .build()
        .await
    {
        Ok(player) => player,
        Err(e) => {
            tracing::warn!("MPRIS unavailable ({e}) — is there a session bus?");
            return;
        }
    };

    let handle = app.clone();
    player.connect_play_pause(move |_| {
        let _ = handle.emit(topic::PLAY_PAUSE, ());
    });
    let handle = app.clone();
    player.connect_play(move |_| {
        let _ = handle.emit(topic::PLAY, ());
    });
    let handle = app.clone();
    player.connect_pause(move |_| {
        let _ = handle.emit(topic::PAUSE, ());
    });
    let handle = app.clone();
    player.connect_stop(move |_| {
        let _ = handle.emit(topic::STOP, ());
    });
    let handle = app.clone();
    player.connect_raise(move |_| {
        crate::commands::raise_main_window(&handle);
    });

    let pump = async {
        while let Some(snapshot) = rx.recv().await {
            apply(&player, &snapshot).await;
        }
    };

    tokio::join!(player.run(), pump);
}

async fn apply(player: &Player, snapshot: &PlaybackSnapshot) {
    let status = match snapshot.state.as_str() {
        "playing" => PlaybackStatus::Playing,
        "paused" => PlaybackStatus::Paused,
        _ => PlaybackStatus::Stopped,
    };
    if let Err(e) = player.set_playback_status(status).await {
        tracing::warn!("MPRIS status update failed: {e}");
    }

    let title = if snapshot.file.is_empty() {
        "Live pattern"
    } else {
        &snapshot.file
    };
    let mut metadata = Metadata::builder()
        .title(title)
        .artist(["Cycletron"])
        .audio_bpm(snapshot.bpm.round() as i32);
    if let Ok(id) = TrackId::try_from(TRACK_ID) {
        metadata = metadata.trackid(id);
    }

    if let Err(e) = player.set_metadata(metadata.build()).await {
        tracing::warn!("MPRIS metadata update failed: {e}");
    }
}

