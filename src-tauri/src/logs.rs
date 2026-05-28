//! In-memory log ring buffer fed by a `tracing` layer. The frontend reads
//! the buffer through `get_logs` and `diagnostic_dump` to power the Logs
//! modal and the "copy diagnostic dump" button.
//!
//! The buffer is bounded (most recent N entries) so it never grows
//! unboundedly even in a long session.

use std::collections::VecDeque;
use std::fmt::Write as _;
use std::sync::{Mutex, OnceLock};
use tracing::{Event, Subscriber};
use tracing_subscriber::Layer;
use tracing_subscriber::layer::Context;

const MAX_ENTRIES: usize = 1500;

#[derive(Debug, Clone, serde::Serialize)]
pub struct LogEntry {
    /// Unix epoch milliseconds when the event fired.
    pub ts_ms: i64,
    pub level: String,
    pub target: String,
    pub message: String,
}

static LOG_RING: OnceLock<Mutex<VecDeque<LogEntry>>> = OnceLock::new();

fn ring() -> &'static Mutex<VecDeque<LogEntry>> {
    LOG_RING.get_or_init(|| Mutex::new(VecDeque::with_capacity(MAX_ENTRIES)))
}

pub fn snapshot() -> Vec<LogEntry> {
    ring().lock().unwrap().iter().cloned().collect()
}

pub fn clear() {
    ring().lock().unwrap().clear();
}

pub struct InMemoryLayer;

impl<S: Subscriber> Layer<S> for InMemoryLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let metadata = event.metadata();
        let mut message = String::new();
        let mut visitor = MessageVisitor(&mut message);
        event.record(&mut visitor);

        let entry = LogEntry {
            ts_ms: chrono::Utc::now().timestamp_millis(),
            level: metadata.level().to_string(),
            target: metadata.target().to_string(),
            message,
        };

        let mut ring = ring().lock().unwrap();
        if ring.len() == MAX_ENTRIES {
            ring.pop_front();
        }
        ring.push_back(entry);
    }
}

struct MessageVisitor<'a>(&'a mut String);

impl<'a> tracing::field::Visit for MessageVisitor<'a> {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            if !self.0.is_empty() {
                self.0.push(' ');
            }
            self.0.push_str(value);
        } else {
            let _ = write!(self.0, " {}={value:?}", field.name());
        }
    }

    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            if !self.0.is_empty() {
                self.0.push(' ');
            }
            let _ = write!(self.0, "{value:?}");
        } else {
            let _ = write!(self.0, " {}={value:?}", field.name());
        }
    }
}
