//! Ableton Link — shared tempo and bar phase with any Link-enabled app.
//!
//! Link is peer-to-peer tempo and beat-phase sync over the local network. It is
//! built into Ableton Live, Bitwig, Rekordbox and a long tail of iOS apps, so
//! joining a session is how Cycletron plays alongside a DAW without either side
//! knowing anything about the other. Discovery is automatic — there is no host,
//! no port and nothing to configure.
//!
//! ## Why the timeline maps cleanly
//!
//! Cycletron's `cps` is `bpm / 240`, so one cycle is four beats — one bar at the
//! `setbpm` convention. Link's timeline is measured in beats against a *quantum*,
//! and at [`QUANTUM`] = 4 a Link bar is exactly one Cycletron cycle. Cycle-space
//! and Link-space differ only by a factor of four; there is no phase mismatch to
//! reconcile.
//!
//! ## Tempo goes both ways
//!
//! Cycletron is a full peer: a local tempo change (slider, `setbpm`, the
//! assistant) is committed to the session with [`link_set_tempo`], and a
//! peer's change comes back through [`link_snapshot`]. Start/stop sync is not
//! enabled.
//!
//! Phase is reported as [`LinkSnapshot::seconds_to_next_bar`] rather than as an
//! absolute position on Link's clock. The frontend's clock is the
//! `AudioContext`, whose time base is unrelated to Link's host clock, and
//! bridging the two across an IPC hop costs more accuracy than it buys. A
//! duration survives the hop intact, which is all that aligning a start needs.

use parking_lot::Mutex;
use rusty_link::{AblLink, SessionState};
use serde::Serialize;

/// Beats per Link bar. Four, because one Cycletron cycle is four beats.
const QUANTUM: f64 = 4.0;

static LINK: Mutex<Option<AblLink>> = Mutex::new(None);

/// The session as of one instant, for the transport and the Preferences readout.
#[derive(Debug, Clone, Serialize)]
pub struct LinkSnapshot {
    /// False when Link is off; every other field is then meaningless.
    pub enabled: bool,
    /// Other participants in the session. Zero is normal and still useful —
    /// Cycletron holds a valid timeline that peers adopt when they arrive.
    pub peers: u64,
    /// Session tempo. Cycletron's BPM follows this.
    pub tempo: f64,
    /// Position on the shared timeline, in beats. Grows without bound.
    pub beat: f64,
    /// Position within the current bar, in beats — `0.0..QUANTUM`.
    pub phase: f64,
    /// Time until the bar line, for scheduling a start that lands on it.
    ///
    /// Exactly zero only when Link is disabled, so a caller can start
    /// immediately without special-casing.
    pub seconds_to_next_bar: f64,
}

impl LinkSnapshot {
    /// The reading a caller gets when Link is off — start now, follow nothing.
    fn disabled() -> Self {
        Self {
            enabled: false,
            peers: 0,
            tempo: 0.0,
            beat: 0.0,
            phase: 0.0,
            seconds_to_next_bar: 0.0,
        }
    }
}

/// Join or leave the Link session.
///
/// Alone, `bpm` becomes the session tempo. With peers already in view the
/// session keeps its tempo and Cycletron follows it, as any app joining a
/// Link session does. Peers that are found after this call merge timelines
/// the same way.
#[tauri::command]
pub fn link_enable(enabled: bool, bpm: f64) -> LinkSnapshot {
    let mut guard = LINK.lock();
    let link = guard.get_or_insert_with(|| AblLink::new(bpm));
    if !enabled {
        link.enable(false);
        return LinkSnapshot::disabled();
    }
    if link.num_peers() == 0 {
        commit_tempo(link, bpm);
    }
    link.enable(true);
    snapshot_of(link)
}

/// Propose a tempo to the session. Every peer follows it.
#[tauri::command]
pub fn link_set_tempo(bpm: f64) -> LinkSnapshot {
    let guard = LINK.lock();
    match guard.as_ref() {
        Some(link) if link.is_enabled() => {
            commit_tempo(link, bpm);
            snapshot_of(link)
        }
        _ => LinkSnapshot::disabled(),
    }
}

fn commit_tempo(link: &AblLink, bpm: f64) {
    let mut state = SessionState::new();
    link.capture_app_session_state(&mut state);
    state.set_tempo(bpm, link.clock_micros());
    link.commit_app_session_state(&state);
}

/// Read the session. Polled by the frontend; cheap enough for the UI loop.
#[tauri::command]
pub fn link_snapshot() -> LinkSnapshot {
    let guard = LINK.lock();
    match guard.as_ref() {
        Some(link) if link.is_enabled() => snapshot_of(link),
        _ => LinkSnapshot::disabled(),
    }
}

fn snapshot_of(link: &AblLink) -> LinkSnapshot {
    let mut state = SessionState::new();
    link.capture_app_session_state(&mut state);

    let now = link.clock_micros();
    let tempo = state.tempo();
    let phase = state.phase_at_time(now, QUANTUM);

    LinkSnapshot {
        enabled: true,
        peers: link.num_peers(),
        tempo,
        beat: state.beat_at_time(now, QUANTUM),
        phase,
        seconds_to_next_bar: seconds_to_next_bar(phase, tempo),
    }
}

/// Beats remaining in the bar over beats per second.
///
/// A non-positive tempo would be a Link protocol violation, but the division is
/// guarded anyway: this value gets fed to a timer, and an inf would hang the
/// transport.
fn seconds_to_next_bar(phase: f64, tempo: f64) -> f64 {
    if tempo > 0.0 {
        (QUANTUM - phase) * 60.0 / tempo
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wait_lands_on_the_bar_line() {
        // The arithmetic the transport trusts to start in time with everyone
        // else: phase plus the reported wait, in beats, is exactly one bar.
        for tempo in [60.0, 90.0, 120.0, 142.0, 174.5] {
            for phase in [0.0, 0.25, 1.0, 2.5, 3.999] {
                let beats = seconds_to_next_bar(phase, tempo) * tempo / 60.0;
                assert!(
                    (phase + beats - QUANTUM).abs() < 1e-9,
                    "phase {phase} at {tempo} bpm missed the bar by {}",
                    phase + beats - QUANTUM
                );
            }
        }
        assert_eq!(seconds_to_next_bar(0.0, 120.0), 2.0);
        assert_eq!(seconds_to_next_bar(3.0, 120.0), 0.5);
    }

    #[test]
    fn bad_tempo_starts_now() {
        // A timer fed inf or a negative wait would hang or misfire the transport.
        assert_eq!(seconds_to_next_bar(1.0, 0.0), 0.0);
        assert_eq!(seconds_to_next_bar(1.0, -120.0), 0.0);
    }

    #[test]
    fn disabled_reads_start_now() {
        let off = LinkSnapshot::disabled();
        assert!(!off.enabled);
        assert_eq!(off.seconds_to_next_bar, 0.0);
    }

    // The tests below run a real Link session, which joins any other Link
    // participant on the local network (a DAW, the installed app, another run
    // of these tests). They share one process-global instance, so run them one
    // at a time:
    //
    //     cargo test -p cycletron-app link:: -- --ignored --test-threads=1 --nocapture

    /// The enable → read → set → leave → rejoin contract against a live
    /// session. Needs no other Link peer in view.
    #[test]
    #[ignore = "runs a real Link session on the network"]
    fn session_contract() {
        let idle = link_snapshot();
        assert!(!idle.enabled, "untouched reads as disabled");

        let joined = link_enable(true, 130.0);
        assert!(joined.enabled);
        assert_eq!(joined.peers, 0, "another Link peer is in view");
        assert!(
            (joined.tempo - 130.0).abs() < 1e-9,
            "tempo {}",
            joined.tempo
        );

        let snap = link_snapshot();
        assert!(
            (0.0..QUANTUM).contains(&snap.phase),
            "phase {} escaped the bar",
            snap.phase
        );

        let set = link_set_tempo(142.0);
        assert!((set.tempo - 142.0).abs() < 1e-9, "tempo {}", set.tempo);
        assert!((link_snapshot().tempo - 142.0).abs() < 1e-9);

        // The instance is kept alive, so this asserts `enable(false)` took.
        assert!(!link_enable(false, 130.0).enabled);
        assert!(!link_snapshot().enabled);
        assert!(!link_set_tempo(150.0).enabled, "set while off is a no-op");

        // Rejoining alone takes the new tempo, not the one the instance was
        // created with.
        let rejoined = link_enable(true, 90.0);
        assert!(
            (rejoined.tempo - 90.0).abs() < 1e-9,
            "tempo {}",
            rejoined.tempo
        );
        link_enable(false, 90.0);
    }

    /// Peer discovery. Start any Link app (or this test in a second terminal)
    /// first.
    #[test]
    #[ignore = "needs a second Link peer on the network"]
    fn discovers_peers() {
        link_enable(true, 120.0);
        for _ in 0..40 {
            let snap = link_snapshot();
            if snap.peers > 0 {
                println!("peers={} tempo={:.2}", snap.peers, snap.tempo);
                link_enable(false, 120.0);
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        link_enable(false, 120.0);
        panic!("no Link peers found in 10s — is another Link app running?");
    }
}
