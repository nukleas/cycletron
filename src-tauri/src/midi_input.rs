//! Native MIDI input via the `midir` crate.
//!
//! Opens CoreMIDI/ALSA/WinMM input ports and forwards every note-on,
//! note-off, and control-change message to the frontend as a `midi-input`
//! Tauri event. The frontend ([`ui/src/midi-input.ts`]) fans these out to the
//! live monitor, the capture buffer, the pad-action matcher, and the existing
//! CC → gain/BPM controls.
//!
//! This replaces the old Web MIDI path: the webview no longer needs MIDI
//! permission, and latency/reliability are improved by going through the OS
//! MIDI stack directly.

use midir::{MidiInput, MidiInputConnection};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

/// Information about an available MIDI input device.
#[derive(Debug, Clone, Serialize)]
pub struct MidiDeviceInfo {
    /// Stable-for-this-session index of the port, as a string.
    pub id: String,
    pub name: String,
}

/// A single MIDI message forwarded to the frontend as a `midi-input` event.
#[derive(Debug, Clone, Serialize)]
pub struct MidiInputEvent {
    /// `"note_on"`, `"note_off"`, or `"cc"`.
    pub event_type: String,
    /// Note number, or CC number for `"cc"` events.
    pub note: u8,
    /// Velocity, or CC value for `"cc"` events.
    pub velocity: u8,
    /// 1-based MIDI channel.
    pub channel: u8,
    pub device_name: String,
    /// Unix epoch milliseconds when the message was received.
    pub timestamp: u64,
}

/// Snapshot of the MIDI input subsystem for the Preferences UI.
#[derive(Debug, Clone, Serialize)]
pub struct MidiInputStatus {
    pub is_listening: bool,
    pub connected_devices: Vec<String>,
    pub available_devices: Vec<MidiDeviceInfo>,
}

/// Tauri-managed state holding the open `midir` connections.
///
/// A `MidiInputConnection` keeps the port open and the callback alive for as
/// long as it is held; dropping it closes the port.
pub struct MidiInputState {
    is_listening: AtomicBool,
    connections: Mutex<HashMap<String, MidiInputConnection<()>>>,
    connected_device_names: Mutex<Vec<String>>,
}

impl MidiInputState {
    pub fn new() -> Self {
        Self {
            is_listening: AtomicBool::new(false),
            connections: Mutex::new(HashMap::new()),
            connected_device_names: Mutex::new(Vec::new()),
        }
    }
}

impl Default for MidiInputState {
    fn default() -> Self {
        Self::new()
    }
}

/// Enumerate the currently available MIDI input devices.
#[tauri::command]
pub async fn list_midi_input_devices() -> Result<Vec<MidiDeviceInfo>, String> {
    let midi_in = MidiInput::new("cycletron-input-list")
        .map_err(|e| format!("Failed to create MIDI input: {e}"))?;

    let ports = midi_in.ports();
    let mut devices = Vec::with_capacity(ports.len());
    for (idx, port) in ports.iter().enumerate() {
        let name = midi_in
            .port_name(port)
            .unwrap_or_else(|_| format!("Unknown Device {idx}"));
        devices.push(MidiDeviceInfo {
            id: idx.to_string(),
            name,
        });
    }
    Ok(devices)
}

/// Start listening on a specific device (by index id) or all devices (`None`).
///
/// Each opened port forwards its messages to the frontend via the
/// `midi-input` event. Calling this while already listening tears down the
/// existing connections first.
#[tauri::command]
pub async fn start_midi_input_listening(
    device_id: Option<String>,
    app_handle: AppHandle,
    state: tauri::State<'_, MidiInputState>,
) -> Result<(), String> {
    if state.is_listening.load(Ordering::SeqCst) {
        stop_midi_input_listening_internal(&state);
    }

    // Probe for ports up front so we can report "nothing connected" cleanly.
    let probe = MidiInput::new("cycletron-input")
        .map_err(|e| format!("Failed to create MIDI input: {e}"))?;
    let ports = probe.ports();
    if ports.is_empty() {
        return Err("No MIDI input devices found".to_string());
    }

    // Decide which (index, name) pairs to open.
    let ports_to_connect: Vec<(usize, String)> = if let Some(ref id) = device_id {
        let idx: usize = id.parse().map_err(|_| "Invalid device ID".to_string())?;
        if idx >= ports.len() {
            return Err(format!("Device ID {id} not found"));
        }
        let name = probe
            .port_name(&ports[idx])
            .unwrap_or_else(|_| format!("Device {idx}"));
        vec![(idx, name)]
    } else {
        ports
            .iter()
            .enumerate()
            .map(|(idx, port)| {
                let name = probe
                    .port_name(port)
                    .unwrap_or_else(|_| format!("Device {idx}"));
                (idx, name)
            })
            .collect()
    };
    drop(probe);

    let mut connections = state.connections.lock();
    let mut connected_names = state.connected_device_names.lock();

    for (idx, device_name) in ports_to_connect {
        // `connect` consumes the `MidiInput`, so each port needs a fresh one.
        let midi_in = MidiInput::new(&format!("cycletron-input-{idx}"))
            .map_err(|e| format!("Failed to create MIDI input: {e}"))?;
        let ports = midi_in.ports();
        let port = ports
            .get(idx)
            .ok_or_else(|| format!("Port {idx} not found"))?;

        let app_handle_clone = app_handle.clone();
        let device_name_clone = device_name.clone();

        let conn = midi_in
            .connect(
                port,
                &format!("cycletron-midi-in-{idx}"),
                move |_timestamp, message, _| {
                    if let Some(evt) = parse_midi_message(message, &device_name_clone) {
                        let _ = app_handle_clone.emit("midi-input", evt);
                    }
                },
                (),
            )
            .map_err(|e| format!("Failed to connect to MIDI port {device_name}: {e}"))?;

        connections.insert(device_name.clone(), conn);
        connected_names.push(device_name);
    }

    state.is_listening.store(true, Ordering::SeqCst);
    tracing::info!(
        "MIDI input listening on {} device(s): [{}]",
        connections.len(),
        connected_names.join(", ")
    );
    Ok(())
}

/// Stop listening and close all open MIDI input ports.
#[tauri::command]
pub async fn stop_midi_input_listening(
    state: tauri::State<'_, MidiInputState>,
) -> Result<(), String> {
    stop_midi_input_listening_internal(&state);
    Ok(())
}

fn stop_midi_input_listening_internal(state: &MidiInputState) {
    state.connections.lock().clear();
    state.connected_device_names.lock().clear();
    state.is_listening.store(false, Ordering::SeqCst);
    tracing::info!("MIDI input listening stopped");
}

/// Report whether we're listening, on which devices, and what's available.
#[tauri::command]
pub async fn get_midi_input_status(
    state: tauri::State<'_, MidiInputState>,
) -> Result<MidiInputStatus, String> {
    let connected_devices = state.connected_device_names.lock().clone();
    let available_devices = list_midi_input_devices().await?;
    Ok(MidiInputStatus {
        is_listening: state.is_listening.load(Ordering::SeqCst),
        connected_devices,
        available_devices,
    })
}

/// Decode a raw MIDI status+data byte slice into a [`MidiInputEvent`].
/// Returns `None` for message types we don't forward.
fn parse_midi_message(message: &[u8], device_name: &str) -> Option<MidiInputEvent> {
    if message.len() < 3 {
        return None;
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let status = message[0];
    let channel = (status & 0x0F) + 1;
    let message_type = status & 0xF0;

    let event_type = match message_type {
        // Note-on with zero velocity is a note-off by convention.
        0x90 if message[2] > 0 => "note_on",
        0x90 | 0x80 => "note_off",
        0xB0 => "cc",
        _ => return None,
    };

    Some(MidiInputEvent {
        event_type: event_type.to_string(),
        note: message[1],
        velocity: message[2],
        channel,
        device_name: device_name.to_string(),
        timestamp,
    })
}
