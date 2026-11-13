use serde_json::Value;

use crate::Error;

/// The length of a frame key.
pub const KEY_LEN: usize = pylon_e2ee::key::KEY_LEN;

/// Everything `Engine::open` needs.
#[derive(Clone, Debug)]
pub struct OpenParams {
    /// The router's RTP capabilities, as the node sends them.
    pub router_rtp_capabilities: Value,
    /// The send transport's parameters, as the node sends them.
    pub transport: Value,
    /// Frame encryption, or `None` to send in the clear.
    pub e2ee: Option<E2eeParams>,
    pub video: VideoParams,
}

/// The video codec of a session (AV1 step 2, Q1). H264 when nothing is said.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum VideoCodec {
    #[default]
    H264,
    Av1,
}

impl VideoCodec {
    /// The name in the protocol and in `hello.codecs`.
    pub fn name(self) -> &'static str {
        match self {
            VideoCodec::H264 => "H264",
            VideoCodec::Av1 => "AV1",
        }
    }

    /// The MIME type in the router's capabilities and the RTP parameters.
    pub(crate) fn mime(self) -> &'static str {
        match self {
            VideoCodec::H264 => "video/H264",
            VideoCodec::Av1 => "video/AV1",
        }
    }
}

/// Bitrates for the video, in bits per second, and its codec.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VideoParams {
    pub start_bitrate: u64,
    pub max_bitrate: u64,
    pub codec: VideoCodec,
}

/// Frame encryption for the life of an engine.
#[derive(Clone, PartialEq, Eq)]
pub struct E2eeParams {
    pub format: u8,
    pub epoch: u8,
    pub key: [u8; KEY_LEN],
    pub kid: u8,
    pub counter: u32,
    pub source: SourceBinding,
}

impl std::fmt::Debug for E2eeParams {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never the key bytes.
        f.debug_struct("E2eeParams")
            .field("format", &self.format)
            .field("epoch", &self.epoch)
            .field("kid", &self.kid)
            .field("counter", &self.counter)
            .field("source", &self.source)
            .finish_non_exhaustive()
    }
}

/// The source binding in the frame AAD, as `pylon_e2ee::Source::new` takes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceBinding {
    pub tag: u8,
    pub stream_key: Option<String>,
}

/// What the host forwards to the node untouched.
#[derive(Clone, Debug)]
pub struct Opened {
    /// For `ConnectTransport`.
    pub dtls_parameters: Value,
    /// For `CreateSource`.
    pub rtp_parameters: Value,
}

pub(crate) fn format(id: u8) -> Result<pylon_e2ee::Format, Error> {
    pylon_e2ee::Format::from_id(id).ok_or_else(|| Error::invalid(format!("unknown frame format {id}")))
}

impl SourceBinding {
    pub(crate) fn to_source(&self) -> Result<pylon_e2ee::Source, Error> {
        pylon_e2ee::Source::new(self.tag, self.stream_key.as_deref())
            .ok_or_else(|| Error::invalid(format!("source tag {} does not fit stream key {:?}", self.tag, self.stream_key)))
    }
}

/// The highest bitrate a host may ask for, far above any share, so the arithmetic on it cannot
/// overflow.
pub(crate) const MAX_BITRATE: u64 = 1_000_000_000;

pub(crate) fn check_bitrate(bps: u64) -> Result<(), Error> {
    if !(1..=MAX_BITRATE).contains(&bps) {
        return Err(Error::invalid(format!("bitrate {bps} is not in 1 to {MAX_BITRATE}")));
    }
    Ok(())
}

impl VideoParams {
    pub(crate) fn check(&self) -> Result<(), Error> {
        check_bitrate(self.start_bitrate)?;
        check_bitrate(self.max_bitrate)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_bindings() {
        let stream = SourceBinding { tag: 3, stream_key: Some("probe-stream".into()) };
        assert_eq!(stream.to_source().unwrap(), pylon_e2ee::Source::stream("probe-stream").unwrap());
        assert!(SourceBinding { tag: 3, stream_key: None }.to_source().is_err());
        assert!(SourceBinding { tag: 1, stream_key: Some("x".into()) }.to_source().is_err());
        assert!(SourceBinding { tag: 9, stream_key: None }.to_source().is_err());
    }

    #[test]
    fn formats() {
        assert!(format(1).is_ok());
        assert!(format(0).is_err());
        assert!(format(2).is_err());
    }

    #[test]
    fn bitrates_are_bounded() {
        let video = |start_bitrate, max_bitrate| VideoParams { start_bitrate, max_bitrate, codec: VideoCodec::H264 }.check();
        assert!(video(1, MAX_BITRATE).is_ok());
        assert!(video(0, 1).is_err());
        assert!(video(1, MAX_BITRATE + 1).is_err());
        assert!(video(u64::MAX, 8_000_000).is_err());
    }

    #[test]
    fn debug_hides_the_key() {
        let params = E2eeParams {
            format: 1,
            epoch: 0,
            key: [0xAB; KEY_LEN],
            kid: 1,
            counter: 5,
            source: SourceBinding { tag: 2, stream_key: None },
        };
        let text = format!("{params:?}");
        assert!(!text.contains("171") && !text.to_lowercase().contains("ab, "), "{text}");
    }
}
