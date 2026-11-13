//! The native media engine: transport (str0m), H264 and AV1 packetizers, frame encryption (pylon-e2ee)
//! and the sending loop, driven by a host through `Engine`. With the `encode` feature also the
//! video pipeline: a test pattern through libavcodec's VA-API H264 or AV1 encoder on Linux, its Quick
//! Sync or NVENC H264 encoder on Windows.

#[cfg(all(feature = "crypto-aws-lc", feature = "crypto-rust"))]
compile_error!("enable exactly one of the features crypto-aws-lc and crypto-rust");
#[cfg(not(any(feature = "crypto-aws-lc", feature = "crypto-rust")))]
compile_error!("enable one of the features crypto-aws-lc and crypto-rust");

pub mod av1;
mod engine;
mod error;
pub mod h264;
mod params;
mod source;
pub mod video;
mod wire;

pub use engine::{CloseReason, Engine, Event, IceState, KeyFrameKind, Stats};
pub use error::Error;
pub use params::{E2eeParams, KEY_LEN, OpenParams, Opened, SourceBinding, VideoCodec, VideoParams};
pub use source::{CaptureReport, EncodedFrame, FileSource, FrameSink, PushError, Source, SourceControl, SourceReport, SyntheticSource};

/// The crypto backend this build of str0m uses.
pub const CRYPTO_BACKEND: &str = if cfg!(feature = "crypto-rust") { "rust" } else { "aws-lc" };
