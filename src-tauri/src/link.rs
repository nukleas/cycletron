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

    // Beats remaining in the bar over beats per second. A non-positive tempo
    // would be a Link protocol violation, but the division is guarded anyway:
    // this value gets fed to a timer, and an inf would hang the transport.
    let seconds_to_next_bar = if tempo > 0.0 {
        (QUANTUM - phase) * 60.0 / tempo
    } else {
        0.0
    };

    LinkSnapshot {
        enabled: true,
        peers: link.num_peers(),
        tempo,
        beat: state.beat_at_time(now, QUANTUM),
        phase,
        seconds_to_next_bar,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Link lives behind one process-global instance, so the whole enable →
    /// read → disable contract is asserted in a single test rather than having
    /// sibling tests race each other for it. Same discipline as `osc`.
    #[test]
    fn reports_the_session_timeline() {
        // Untouched: reads as disabled rather than panicking on the empty slot.
        let idle = link_snapshot();
        assert!(!idle.enabled);
        assert_eq!(
            idle.seconds_to_next_bar, 0.0,
            "a disabled read must start now"
        );

        let joined = link_enable(true, 130.0);
        assert!(joined.enabled);
        assert!(joined.tempo > 0.0, "a live session always carries a tempo");

        let snap = link_snapshot();
        assert!(snap.enabled);
        assert!(
            (0.0..QUANTUM).contains(&snap.phase),
            "phase {} escaped the bar",
            snap.phase
        );

        // The whole point of the field: phase plus the reported wait must land
        // exactly on the bar line. This is the arithmetic the transport trusts
        // to start in time with everyone else.
        let beats_remaining = snap.seconds_to_next_bar * snap.tempo / 60.0;
        assert!(
            (snap.phase + beats_remaining - QUANTUM).abs() < 1e-6,
            "phase {} + {beats_remaining} beats missed the bar line",
            snap.phase
        );

        // Setting the tempo alone moves the session.
        let set = link_set_tempo(142.0);
        assert!((set.tempo - 142.0).abs() < 1e-9, "tempo {}", set.tempo);
        assert!((link_snapshot().tempo - 142.0).abs() < 1e-9);

        // Leaving reports disabled, and stays that way on a later read — the
        // instance is kept alive, so this asserts `enable(false)` really took.
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

    /// Peer discovery, which needs a second Link participant on the network and
    /// so is not a hermetic test. Start any Link app (or this same
    /// test in a second terminal) and run:
    ///
    /// ```text
    /// cargo test -p cycletron-app discovers_peers -- --ignored --nocapture
    /// ```
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
