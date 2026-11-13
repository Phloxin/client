use std::fmt;

/// What can go wrong when opening or driving an `Engine`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Parameters from outside that cannot be used.
    InvalidParameters(String),
    /// The operating system refused something (socket, file).
    Io(String),
    /// The call does not fit the engine's state.
    InvalidState(&'static str),
    /// The encoder or the GPU behind it failed.
    Media(String),
    /// The engine has stopped.
    Closed,
}

impl Error {
    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Error::InvalidParameters(message.into())
    }

    pub(crate) fn io(what: &str, error: std::io::Error) -> Self {
        Error::Io(format!("{what}: {error}"))
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::InvalidParameters(message) => write!(f, "invalid parameters: {message}"),
            Error::Io(message) => write!(f, "{message}"),
            Error::InvalidState(message) => write!(f, "{message}"),
            Error::Media(message) => write!(f, "{message}"),
            Error::Closed => f.write_str("the engine has stopped"),
        }
    }
}

impl std::error::Error for Error {}
