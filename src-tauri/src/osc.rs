//! OSC output over UDP.
//!
//! Open Sound Control is the lingua franca of the live-coding ecosystem —
//! Hydra, Resolume, TouchDesigner, SuperCollider, lighting rigs. Streaming the
//! transport and every hap onset out over it lets Cycletron drive any of them
//! without knowing anything about them.
//!
//! The frontend ([`ui/src/osc-out.ts`]) owns the timing: it scans the engine's
//! cycle-view buffer each animation frame and calls in with whatever fired.
//! This module is only the socket. That puts hap emission on a frame boundary
//! (~16 ms), which is right for visuals and lighting and *not* good enough to
//! drive a sampler — the engine would have to hand out full parameter maps
//! before that were possible.
//!
//! ## Address space
//!
//! | Address | Arguments |
//! | --- | --- |
//! | `/cycletron/transport` | `state: string` (`playing`/`paused`/`stopped`), `bpm: f32`, `cps: f32` |
//! | `/cycletron/cycle` | `cycle: f32` — absolute transport position, sent continuously |
//! | `/cycletron/hap` | `track: string`, `note: f32` (NaN when unpitched), `dur: f32` (cycles), `index: i32` |

use parking_lot::Mutex;
use rosc::{OscBundle, OscMessage, OscPacket, OscTime, OscType};
use serde::{Deserialize, Serialize};
use std::net::{ToSocketAddrs, UdpSocket};

/// A hap onset the frontend observed this frame.
#[derive(Debug, Clone, Deserialize)]
pub struct OscHap {
    /// Track name, which the engine derives from the hap's sound.
    pub track: String,
    /// MIDI note number, or `null` for an unpitched hit.
    pub note: Option<f32>,
    /// Event length in cycles.
    pub dur: f32,
    /// Track index within the current bar, for receivers that prefer a number.
    pub index: i32,
}

/// Result of (re)configuring the sink, for the Preferences readout.
#[derive(Debug, Clone, Serialize)]
pub struct OscStatus {
    pub enabled: bool,
    /// Resolved `host:port` actually being sent to, empty when disabled.
    pub target: String,
}

struct Sink {
    socket: UdpSocket,
    target: std::net::SocketAddr,
}

static SINK: Mutex<Option<Sink>> = Mutex::new(None);

/// Point OSC output at `host:port`, or tear it down when `enabled` is false.
///
/// Binds an ephemeral local port on the matching IP version. Errors here are
/// configuration problems (bad host, unusable port) and are surfaced to the
/// user rather than logged and swallowed.
#[tauri::command]
pub fn osc_configure(enabled: bool, host: String, port: u16) -> Result<OscStatus, String> {
    if !enabled {
        *SINK.lock() = None;
        return Ok(OscStatus {
            enabled: false,
            target: String::new(),
        });
    }

    let target = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| format!("could not resolve {host}:{port} — {e}"))?
        .next()
        .ok_or_else(|| format!("{host}:{port} resolved to no address"))?;

    // Bind the wildcard of the same family so IPv6 targets work too.
    let bind = if target.is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    };
    let socket = UdpSocket::bind(bind).map_err(|e| format!("could not open a UDP socket — {e}"))?;

    // Multicast and broadcast addresses are common OSC targets for lighting.
    socket.set_broadcast(true).ok();

    *SINK.lock() = Some(Sink { socket, target });

    Ok(OscStatus {
        enabled: true,
        target: target.to_string(),
    })
}

/// Announce a transport change. Cheap and rare — sent on play/pause/stop.
#[tauri::command]
pub fn osc_transport(state: String, bpm: f32, cps: f32) {
    send(OscPacket::Message(OscMessage {
        addr: "/cycletron/transport".into(),
        args: vec![
            OscType::String(state),
            OscType::Float(bpm),
            OscType::Float(cps),
        ],
    }));
}

/// Emit one frame: the transport position, plus every hap that just started.
///
/// Bundled into a single datagram so a receiver sees the position and the
/// onsets that belong to it together, rather than interleaved with the next
/// frame's.
#[tauri::command]
pub fn osc_frame(cycle: f32, haps: Vec<OscHap>) {
    if SINK.lock().is_none() {
        return; // disabled — skip building the packet at all
    }

    let mut content = Vec::with_capacity(haps.len() + 1);
    content.push(OscPacket::Message(OscMessage {
        addr: "/cycletron/cycle".into(),
        args: vec![OscType::Float(cycle)],
    }));

    for hap in haps {
        content.push(OscPacket::Message(OscMessage {
            addr: "/cycletron/hap".into(),
            args: vec![
                OscType::String(hap.track),
                // Unpitched hits still carry a slot, so receivers can index
                // arguments positionally without checking the type tag.
                OscType::Float(hap.note.unwrap_or(f32::NAN)),
                OscType::Float(hap.dur),
                OscType::Int(hap.index),
            ],
        }));
    }

    send(OscPacket::Bundle(OscBundle {
        // "Immediately" — we are already sending at the moment of playback, and
        // no common receiver schedules on timetags anyway.
        timetag: OscTime::from((0, 1)),
        content,
    }));
}

/// Encode and fire a packet. Send failures are dropped on purpose: OSC is
/// unreliable by design, and a missing visuals receiver must never disturb
/// the audio thread's neighbour on the main thread.
fn send(packet: OscPacket) {
    let guard = SINK.lock();
    let Some(sink) = guard.as_ref() else {
        return;
    };
    if let Ok(bytes) = rosc::encoder::encode(&packet) {
        let _ = sink.socket.send_to(&bytes, sink.target);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Everything lives behind one process-global sink, so the whole contract is
    /// asserted in a single test rather than racing sibling tests for it.
    #[test]
    fn sends_transport_and_frame_over_udp() {
        let listener = UdpSocket::bind("127.0.0.1:0").expect("bind listener");
        listener
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let port = listener.local_addr().unwrap().port();

        let status = osc_configure(true, "127.0.0.1".into(), port).expect("configure");
        assert!(status.enabled);
        assert_eq!(status.target, format!("127.0.0.1:{port}"));

        // --- transport ---
        osc_transport("playing".into(), 128.0, 128.0 / 240.0);
        let msg = match recv(&listener) {
            OscPacket::Message(m) => m,
            other => panic!("expected a message, got {other:?}"),
        };
        assert_eq!(msg.addr, "/cycletron/transport");
        assert_eq!(msg.args[0], OscType::String("playing".into()));
        assert_eq!(msg.args[1], OscType::Float(128.0));

        // --- frame: cycle plus one pitched and one unpitched hap ---
        osc_frame(
            12.5,
            vec![
                OscHap {
                    track: "bd".into(),
                    note: None,
                    dur: 0.25,
                    index: 0,
                },
                OscHap {
                    track: "bass".into(),
                    note: Some(36.0),
                    dur: 0.5,
                    index: 1,
                },
            ],
        );

        let OscPacket::Bundle(bundle) = recv(&listener) else {
            panic!("expected a bundle");
        };
        assert_eq!(bundle.content.len(), 3, "cycle + two haps");

        let msgs: Vec<&OscMessage> = bundle
            .content
            .iter()
            .map(|p| match p {
                OscPacket::Message(m) => m,
                other => panic!("expected messages in the bundle, got {other:?}"),
            })
            .collect();

        assert_eq!(msgs[0].addr, "/cycletron/cycle");
        assert_eq!(msgs[0].args[0], OscType::Float(12.5));

        assert_eq!(msgs[1].addr, "/cycletron/hap");
        assert_eq!(msgs[1].args[0], OscType::String("bd".into()));
        // Unpitched hits still occupy the note slot, as NaN.
        let OscType::Float(note) = msgs[1].args[1] else {
            panic!("note arg should be a float");
        };
        assert!(note.is_nan(), "unpitched hap should send NaN, got {note}");
        assert_eq!(msgs[1].args[2], OscType::Float(0.25));
        assert_eq!(msgs[1].args[3], OscType::Int(0));

        assert_eq!(msgs[2].args[0], OscType::String("bass".into()));
        assert_eq!(msgs[2].args[1], OscType::Float(36.0));
        assert_eq!(msgs[2].args[3], OscType::Int(1));

        // --- disabling stops the stream ---
        let status = osc_configure(false, String::new(), 0).expect("disable");
        assert!(!status.enabled);
        osc_frame(13.0, vec![]);
        listener
            .set_read_timeout(Some(Duration::from_millis(150)))
            .unwrap();
        let mut buf = [0u8; 4096];
        assert!(
            listener.recv_from(&mut buf).is_err(),
            "nothing should be sent once OSC output is disabled"
        );

        // --- a bad host is reported, not silently swallowed ---
        assert!(osc_configure(true, "no.such.host.invalid".into(), 1).is_err());
    }

    fn recv(sock: &UdpSocket) -> OscPacket {
        let mut buf = [0u8; 8192];
        let (n, _) = sock.recv_from(&mut buf).expect("receive an OSC packet");
        rosc::decoder::decode_udp(&buf[..n]).expect("decode").1
    }
}
