//! Why a surgical edit could not be made. The agent loop maps each variant to
//! a tool-result category, so the model learns *what kind* of miss it was
//! without parsing the message.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocError {
    /// The caller passed nothing usable: empty code, or a new track without an
    /// addressable id.
    BadArgument(String),
    /// The addressed track / section / binding does not exist. The message
    /// lists what does.
    NotFound(String),
    /// The document has no structure of that kind to edit (no `$:` tracks,
    /// no section object, no bindings).
    NoStructure(String),
}

impl fmt::Display for DocError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadArgument(m) | Self::NotFound(m) | Self::NoStructure(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for DocError {}
