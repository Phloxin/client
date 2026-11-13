// The control protocol, version 1 (PROTOCOL.md): one JSON object per line, externally tagged
// with snake_case names.

use base64::{Engine as _, engine::general_purpose::STANDARD};
use pylon_media::{E2eeParams, IceState, KEY_LEN, KeyFrameKind, SourceBinding, Stats, VideoCodec, VideoParams};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL: u32 = 1;

/// Every message name the host may send.
const REQUESTS: [&str; 9] = ["hello", "capture", "open", "start", "key", "set_max_bitrate", "preview", "test_drop_media", "close"];

/// A message from the host.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Request {
    Hello { protocol: u32 },
    Capture(Capture),
    Open(Open),
    Start {},
    Key(Key),
    SetMaxBitrate { bps: u64 },
    Preview(Preview),
    TestDropMedia { count: u64 },
    Close {},
}

/// What the sharer's preview should be, after `open` (M6 preview step 1, R1).
#[derive(Debug, Deserialize, PartialEq, Eq)]
pub struct Preview {
    pub fps: u32,
    pub max_width: u32,
    pub max_height: u32,
}

impl Preview {
    pub fn to_engine(&self) -> pylon_media::video::PreviewRequest {
        pylon_media::video::PreviewRequest { fps: self.fps, max_width: self.max_width, max_height: self.max_height }
    }
}

/// A preview picture as base64 of its JPEG, which is never printed (R5).
#[derive(Serialize)]
#[serde(transparent)]
pub struct Jpeg(pub String);

impl std::fmt::Debug for Jpeg {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Jpeg({} base64 characters)", self.0.len())
    }
}

/// What to capture before `open` (M5b D8). Only the screen for now.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Capture {
    Screen(ScreenCapture),
}

#[derive(Debug, Deserialize, PartialEq)]
pub struct ScreenCapture {
    /// From an earlier `capture_ready`, so the portal may not need to ask again. Ignored on
    /// Windows.
    #[serde(default)]
    pub restore_token: Option<String>,
    /// The most frames a second to ask of the compositor, the share's rate (M5b D13).
    #[serde(default)]
    pub max_fps: Option<u32>,
    /// What to capture on Windows, the primary monitor when absent (M7.5 C1). Ignored on Linux,
    /// where the portal's dialog chooses.
    #[serde(default)]
    #[cfg_attr(not(all(feature = "capture", target_os = "windows")), allow(dead_code))]
    pub target: Option<CaptureTarget>,
}

/// A window by its handle, or the monitor that holds a point in physical pixels of the virtual
/// screen.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(not(all(feature = "capture", target_os = "windows")), allow(dead_code))]
pub enum CaptureTarget {
    Window(u64),
    Monitor { x: i32, y: i32 },
}

#[derive(Debug, Deserialize, PartialEq)]
pub struct Open {
    pub router_rtp_capabilities: Value,
    pub transport: Value,
    // Required, so that sending in the clear is always said out loud with `null`.
    #[serde(deserialize_with = "Option::deserialize")]
    pub e2ee: Option<E2ee>,
    pub source: SourceSpec,
    pub video: Video,
}

#[derive(Deserialize, PartialEq)]
pub struct E2ee {
    pub format: u8,
    pub epoch: u8,
    /// Base64 of the 16 byte key.
    pub key: String,
    pub kid: u8,
    pub counter: u32,
    pub source: Binding,
}

impl std::fmt::Debug for E2ee {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never the key, so `Open` and `Request` print without it too.
        f.debug_struct("E2ee")
            .field("format", &self.format)
            .field("epoch", &self.epoch)
            .field("kid", &self.kid)
            .field("counter", &self.counter)
            .field("source", &self.source)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Deserialize, PartialEq)]
pub struct Binding {
    pub tag: u8,
    #[serde(default)]
    pub stream_key: Option<String>,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SourceSpec {
    File { path: String, fps: u32 },
    Synthetic { fps: u32 },
    Pattern(Pattern),
    Screen(Screen),
}

/// The captured screen through the hardware encoder, valid after `capture_ready`.
#[derive(Debug, Deserialize, PartialEq)]
pub struct Screen {
    pub fps: u32,
    pub max_width: u32,
    pub max_height: u32,
}

/// The test pattern through the hardware encoder, sent at its own size and rate.
#[derive(Debug, Deserialize, PartialEq)]
pub struct Pattern {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    #[serde(default)]
    pub still: bool,
    #[serde(default)]
    pub kind: PatternKind,
}

/// Which picture the pattern shows.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PatternKind {
    #[default]
    Screen,
    Stress,
}

#[derive(Debug, Deserialize, PartialEq)]
pub struct Video {
    pub start_bitrate: u64,
    pub max_bitrate: u64,
    /// `"H264"` (when absent) or `"AV1"` (AV1 step 2, Q1). Anything else does not parse, which
    /// makes `open` fail.
    #[serde(default)]
    pub codec: Codec,
}

/// The session's video codec, as the protocol names it.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
pub enum Codec {
    #[default]
    #[serde(rename = "H264")]
    H264,
    #[serde(rename = "AV1")]
    Av1,
}

impl Codec {
    pub fn to_engine(self) -> VideoCodec {
        match self {
            Codec::H264 => VideoCodec::H264,
            Codec::Av1 => VideoCodec::Av1,
        }
    }
}

#[derive(Deserialize, PartialEq)]
pub struct Key {
    pub format: u8,
    pub epoch: u8,
    pub key: String,
}

impl std::fmt::Debug for Key {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Key").field("format", &self.format).field("epoch", &self.epoch).finish_non_exhaustive()
    }
}

/// Why a line could not be read as a request.
#[derive(Debug, PartialEq)]
pub enum ParseError {
    NotJson(String),
    Unknown(String),
    /// A known message with fields that do not fit.
    Invalid { name: String, message: String },
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::NotJson(message) => write!(f, "not JSON: {message}"),
            ParseError::Unknown(name) => write!(f, "unknown message {name}"),
            ParseError::Invalid { name, message } => write!(f, "{name}: {message}"),
        }
    }
}

// Errors never repeat the input or serde's quoted values: a line may carry a frame key.
pub fn parse(line: &str) -> Result<Request, ParseError> {
    let value: Value = serde_json::from_str(line)
        .map_err(|e| ParseError::NotJson(format!("line {} column {}", e.line(), e.column())))?;
    let name = match value.as_object() {
        Some(object) if object.len() == 1 => object.keys().next().cloned().unwrap_or_default(),
        _ => return Err(ParseError::Unknown("(not one object with one name)".into())),
    };
    if !REQUESTS.contains(&name.as_str()) {
        return Err(ParseError::Unknown(if plain_name(&name) { name } else { "(not a plain name)".into() }));
    }
    serde_json::from_value(value).map_err(|e| ParseError::Invalid {
        message: field_error(&e.to_string()),
        name,
    })
}

/// Lower case letters and underscores only, as every message name is. Such a name cannot be a
/// base64 key, which always ends in `==`.
fn plain_name(name: &str) -> bool {
    (1..=32).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
}

/// A missing field is named (the name is ours), anything else gets a fixed text.
fn field_error(serde: &str) -> String {
    if let Some(rest) = serde.strip_prefix("missing field `")
        && let Some((field, _)) = rest.split_once('`')
    {
        return format!("missing field `{field}`");
    }
    "the fields do not fit the message".into()
}

pub fn decode_key(key: &str) -> Result<[u8; KEY_LEN], String> {
    let bytes = STANDARD.decode(key).map_err(|_| "key is not base64".to_string())?;
    let len = bytes.len();
    bytes
        .try_into()
        .map_err(|_| format!("key is {len} bytes, expected {KEY_LEN}"))
}

impl E2ee {
    pub fn to_params(&self) -> Result<E2eeParams, String> {
        Ok(E2eeParams {
            format: self.format,
            epoch: self.epoch,
            key: decode_key(&self.key)?,
            kid: self.kid,
            counter: self.counter,
            source: SourceBinding {
                tag: self.source.tag,
                stream_key: self.source.stream_key.clone(),
            },
        })
    }
}

impl Video {
    pub fn to_params(&self) -> VideoParams {
        VideoParams {
            start_bitrate: self.start_bitrate,
            max_bitrate: self.max_bitrate,
            codec: self.codec.to_engine(),
        }
    }
}

/// A message to the host.
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reply {
    Hello {
        protocol: u32,
        engine: &'static str,
        codecs: Vec<&'static str>,
        sources: Vec<&'static str>,
    },
    #[cfg_attr(not(feature = "capture"), allow(dead_code))]
    CaptureReady {
        width: u32,
        height: u32,
        /// DRM fourcc text, `XR24` for BGRx. `null` on Windows (M7.5 C12).
        format: Option<String>,
        /// The DMA-BUF modifier as `0x` and 16 hex digits (a number would not survive
        /// JavaScript), `null` on the memory path.
        modifier: Option<String>,
        dmabuf: bool,
        restore_token: Option<String>,
    },
    CaptureCancelled {},
    CaptureChanged {
        width: u32,
        height: u32,
    },
    Opened {
        dtls_parameters: Value,
        rtp_parameters: Value,
    },
    IceState {
        state: IceState,
    },
    Connected {},
    KeyFrameRequest {
        kind: KeyFrameKind,
    },
    Stats(Stats),
    Error {
        message: String,
        fatal: bool,
    },
    Closed {
        reason: &'static str,
    },
    /// One preview picture (R1), only to the host (R5).
    Preview {
        width: u32,
        height: u32,
        jpeg: Jpeg,
    },
}

impl Reply {
    /// The line for stdout, with `t_ms` added to the message's fields.
    pub fn to_line(&self, t_ms: f64) -> String {
        let mut value = serde_json::to_value(self).unwrap_or(Value::Null);
        if let Some(fields) = value
            .as_object_mut()
            .and_then(|o| o.values_mut().next())
            .and_then(Value::as_object_mut)
        {
            let t_ms = (t_ms * 1000.0).round() / 1000.0;
            fields.insert("t_ms".into(), t_ms.into());
        }
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // The examples in PROTOCOL.md, as written there.
    const HELLO: &str = r#"{"hello": {"protocol": 1}}"#;
    const OPEN: &str = r#"{"open": {
        "router_rtp_capabilities": {"codecs": [], "headerExtensions": []},
        "transport": {"id": "5ab0b66c", "ice_parameters": {}, "ice_candidates": [], "dtls_parameters": {}},
        "e2ee": {"format": 1, "epoch": 0, "key": "AAECAwQFBgcICQoLDA0ODw==", "kid": 1, "counter": 12345,
                 "source": {"tag": 3, "stream_key": "probe-stream"}},
        "source": {"file": {"path": "/tmp/testsrc2-720p30.h264", "fps": 30}},
        "video": {"start_bitrate": 1500000, "max_bitrate": 8000000}}}"#;
    const START: &str = r#"{"start": {}}"#;
    const KEY: &str = r#"{"key": {"format": 1, "epoch": 1, "key": "AAECAwQFBgcICQoLDA0ODw=="}}"#;
    const SET_MAX_BITRATE: &str = r#"{"set_max_bitrate": {"bps": 4000000}}"#;
    const TEST_DROP_MEDIA: &str = r#"{"test_drop_media": {"count": 40}}"#;
    const CLOSE: &str = r#"{"close": {}}"#;

    #[test]
    fn requests_parse() {
        assert_eq!(parse(HELLO), Ok(Request::Hello { protocol: 1 }));
        assert_eq!(parse(START), Ok(Request::Start {}));
        assert_eq!(parse(CLOSE), Ok(Request::Close {}));
        assert_eq!(parse(SET_MAX_BITRATE), Ok(Request::SetMaxBitrate { bps: 4_000_000 }));
        assert_eq!(parse(TEST_DROP_MEDIA), Ok(Request::TestDropMedia { count: 40 }));
        assert_eq!(
            parse(KEY),
            Ok(Request::Key(Key {
                format: 1,
                epoch: 1,
                key: "AAECAwQFBgcICQoLDA0ODw==".into()
            }))
        );

        let Ok(Request::Open(open)) = parse(OPEN) else {
            panic!("open did not parse");
        };
        assert_eq!(open.transport["id"], "5ab0b66c");
        assert_eq!(open.source, SourceSpec::File { path: "/tmp/testsrc2-720p30.h264".into(), fps: 30 });
        assert_eq!(open.video, Video { start_bitrate: 1_500_000, max_bitrate: 8_000_000, codec: Codec::H264 });
        let e2ee = open.e2ee.unwrap().to_params().unwrap();
        assert_eq!(e2ee.key, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
        assert_eq!((e2ee.format, e2ee.epoch, e2ee.kid, e2ee.counter), (1, 0, 1, 12345));
        assert_eq!(e2ee.source, SourceBinding { tag: 3, stream_key: Some("probe-stream".into()) });
    }

    #[test]
    fn the_codec_is_h264_unless_av1_is_said() {
        let mut open: Value = serde_json::from_str(OPEN).unwrap();
        let parsed = |open: &Value| match parse(&open.to_string()) {
            Ok(Request::Open(parsed)) => Ok(parsed.video.codec),
            Ok(other) => panic!("{other:?}"),
            Err(error) => Err(error),
        };
        assert_eq!(parsed(&open), Ok(Codec::H264));
        open["open"]["video"]["codec"] = json!("H264");
        assert_eq!(parsed(&open), Ok(Codec::H264));
        open["open"]["video"]["codec"] = json!("AV1");
        assert_eq!(parsed(&open), Ok(Codec::Av1));
        assert_eq!(Codec::Av1.to_engine(), VideoCodec::Av1);
        // Anything else is an `open` that does not parse, which the host makes fatal.
        for other in [json!("av1"), json!("VP8"), json!(1), json!(null)] {
            open["open"]["video"]["codec"] = other;
            assert_eq!(parsed(&open), Err(ParseError::Invalid { name: "open".into(), message: "the fields do not fit the message".into() }));
        }
    }

    #[test]
    fn plain_and_synthetic_open_parse() {
        let mut open: Value = serde_json::from_str(OPEN).unwrap();
        open["open"]["e2ee"] = Value::Null;
        open["open"]["source"] = json!({ "synthetic": { "fps": 60 } });
        let Ok(Request::Open(open)) = parse(&open.to_string()) else {
            panic!("open did not parse");
        };
        assert_eq!(open.e2ee, None);
        assert_eq!(open.source, SourceSpec::Synthetic { fps: 60 });
    }

    #[test]
    fn pattern_open_parses() {
        let mut open: Value = serde_json::from_str(OPEN).unwrap();
        open["open"]["source"] = json!({ "pattern": { "width": 1920, "height": 1080, "fps": 60, "still": true, "kind": "stress" } });
        let Ok(Request::Open(parsed)) = parse(&open.to_string()) else {
            panic!("open did not parse");
        };
        assert_eq!(parsed.source, SourceSpec::Pattern(Pattern { width: 1920, height: 1080, fps: 60, still: true, kind: PatternKind::Stress }));
        // `still` may be left out.
        open["open"]["source"] = json!({ "pattern": { "width": 1280, "height": 720, "fps": 30 } });
        let Ok(Request::Open(parsed)) = parse(&open.to_string()) else {
            panic!("open did not parse");
        };
        assert_eq!(parsed.source, SourceSpec::Pattern(Pattern { width: 1280, height: 720, fps: 30, still: false, kind: PatternKind::Screen }));
    }

    #[test]
    fn capture_and_screen_parse() {
        assert_eq!(
            parse(r#"{"capture": {"screen": {"restore_token": "abc"}}}"#),
            Ok(Request::Capture(Capture::Screen(ScreenCapture { restore_token: Some("abc".into()), max_fps: None, target: None })))
        );
        assert_eq!(
            parse(r#"{"capture": {"screen": {"restore_token": null, "max_fps": 60}}}"#),
            Ok(Request::Capture(Capture::Screen(ScreenCapture { restore_token: None, max_fps: Some(60), target: None })))
        );
        // Windows' targets (M7.5 C1).
        assert_eq!(
            parse(r#"{"capture": {"screen": {"max_fps": 60, "target": {"window": 1050122}}}}"#),
            Ok(Request::Capture(Capture::Screen(ScreenCapture { restore_token: None, max_fps: Some(60), target: Some(CaptureTarget::Window(1_050_122)) })))
        );
        assert_eq!(
            parse(r#"{"capture": {"screen": {"target": {"monitor": {"x": -1920, "y": 10}}}}}"#),
            Ok(Request::Capture(Capture::Screen(ScreenCapture { restore_token: None, max_fps: None, target: Some(CaptureTarget::Monitor { x: -1920, y: 10 }) })))
        );
        assert!(matches!(parse(r#"{"capture": {"screen": {"target": {"window": "x"}}}}"#), Err(ParseError::Invalid { .. })));
        assert!(matches!(parse(r#"{"capture": {"camera": {}}}"#), Err(ParseError::Invalid { .. })));
        let mut open: Value = serde_json::from_str(OPEN).unwrap();
        open["open"]["source"] = json!({ "screen": { "fps": 60, "max_width": 1920, "max_height": 1080 } });
        let Ok(Request::Open(parsed)) = parse(&open.to_string()) else {
            panic!("open did not parse");
        };
        assert_eq!(parsed.source, SourceSpec::Screen(Screen { fps: 60, max_width: 1920, max_height: 1080 }));
    }

    #[test]
    fn capture_replies_print() {
        let line = |reply: Reply| serde_json::from_str::<Value>(&reply.to_line(1.0)).unwrap();
        assert_eq!(
            line(Reply::CaptureReady {
                width: 2560,
                height: 1440,
                format: Some("XR24".into()),
                modifier: Some("0x0200000018fb1b03".into()),
                dmabuf: true,
                restore_token: Some("t".into()),
            }),
            json!({"capture_ready": {"width": 2560, "height": 1440, "format": "XR24", "modifier": "0x0200000018fb1b03",
                   "dmabuf": true, "restore_token": "t", "t_ms": 1.0}})
        );
        // As on Windows (M7.5 C12).
        assert_eq!(
            line(Reply::CaptureReady { width: 1920, height: 1080, format: None, modifier: None, dmabuf: false, restore_token: None }),
            json!({"capture_ready": {"width": 1920, "height": 1080, "format": null, "modifier": null,
                   "dmabuf": false, "restore_token": null, "t_ms": 1.0}})
        );
        assert_eq!(line(Reply::CaptureCancelled {}), json!({"capture_cancelled": {"t_ms": 1.0}}));
        assert_eq!(line(Reply::CaptureChanged { width: 800, height: 600 }), json!({"capture_changed": {"width": 800, "height": 600, "t_ms": 1.0}}));
    }

    #[test]
    fn preview_parses_and_prints() {
        assert_eq!(
            parse(r#"{"preview": {"fps": 5, "max_width": 480, "max_height": 270}}"#),
            Ok(Request::Preview(Preview { fps: 5, max_width: 480, max_height: 270 }))
        );
        // All three fields are needed, the limits are checked by the engine.
        assert!(matches!(parse(r#"{"preview": {"fps": 5}}"#), Err(ParseError::Invalid { .. })));
        assert!(matches!(parse(r#"{"preview": {"fps": -1, "max_width": 480, "max_height": 270}}"#), Err(ParseError::Invalid { .. })));
        let line = Reply::Preview { width: 480, height: 270, jpeg: Jpeg("/9j/".into()) }.to_line(5.0);
        assert_eq!(serde_json::from_str::<Value>(&line).unwrap(), json!({"preview": {"width": 480, "height": 270, "jpeg": "/9j/", "t_ms": 5.0}}));
        assert_eq!(format!("{:?}", Jpeg("/9j/4AAQ".into())), "Jpeg(8 base64 characters)");
    }

    #[test]
    fn e2ee_must_be_given() {
        let mut open: Value = serde_json::from_str(OPEN).unwrap();
        open["open"].as_object_mut().unwrap().remove("e2ee");
        assert!(matches!(parse(&open.to_string()), Err(ParseError::Invalid { name, .. }) if name == "open"));
    }

    #[test]
    fn bad_lines() {
        assert!(matches!(parse("hello"), Err(ParseError::NotJson(_))));
        assert_eq!(parse(r#"{"dance": {}}"#), Err(ParseError::Unknown("dance".into())));
        assert!(matches!(parse(r#"{"hello": {}, "close": {}}"#), Err(ParseError::Unknown(_))));
        assert!(matches!(parse("[1]"), Err(ParseError::Unknown(_))));
        assert!(matches!(parse(r#"{"hello": {"protocol": "one"}}"#), Err(ParseError::Invalid { .. })));
        assert!(matches!(parse(r#"{"set_max_bitrate": {}}"#), Err(ParseError::Invalid { .. })));
    }

    const SECRET: &str = "AAECAwQFBgcICQoLDA0ODw==";

    #[test]
    fn debug_leaves_the_key_out() {
        let open = parse(OPEN).unwrap();
        let key = parse(KEY).unwrap();
        for text in [format!("{open:?}"), format!("{key:?}")] {
            assert!(!text.contains(SECRET) && !text.contains("AAECAw"), "{text}");
        }
        assert!(format!("{open:?}").contains("kid: 1"));
    }

    #[test]
    fn errors_do_not_repeat_the_input() {
        let lines = [
            // serde would quote the value it did not expect.
            format!(r#"{{"key": {{"format": "{SECRET}", "epoch": 1, "key": "{SECRET}"}}}}"#),
            format!(r#"{{"key": {{"format": 1, "epoch": 1, "key": ["{SECRET}"]}}}}"#),
            format!(r#"{{"open": {{"e2ee": {{"format": 1, "epoch": 0, "key": "{SECRET}", "kid": "{SECRET}"}}}}}}"#),
            format!(r#"{{"open": {{"router_rtp_capabilities": {{}}, "transport": {{}}, "e2ee": {{"format": 1, "epoch": 0, "key": "{SECRET}", "kid": 1, "counter": 1, "source": {{"tag": 3}}}}, "source": {{"{SECRET}": {{}}}}, "video": {{}}}}}}"#),
            // Two names, or the key as a name.
            format!(r#"{{"key": {{"format": 1, "epoch": 1, "key": "{SECRET}"}}, "close": {{}}}}"#),
            format!(r#"{{"{SECRET}": {{}}}}"#),
            // Not JSON after the key.
            format!(r#"{{"key": {{"format": 1, "epoch": 1, "key": "{SECRET}" "#),
        ];
        for line in &lines {
            let error = parse(line).unwrap_err();
            let text = format!("{error} {error:?}");
            assert!(!text.contains(SECRET) && !text.contains("AAECAw"), "{text}");
        }
        assert_eq!(parse(&lines[0]).unwrap_err().to_string(), "key: the fields do not fit the message");
        assert_eq!(parse(r#"{"open": {}}"#).unwrap_err().to_string(), "open: missing field `router_rtp_capabilities`");
        // An invalid last symbol is a character of the key text.
        assert_eq!(decode_key("AAECAwQFBgcICQoLDA0ODx==").unwrap_err(), "key is not base64");
    }

    #[test]
    fn keys() {
        assert!(decode_key("AAECAwQFBgcICQoLDA0ODw==").is_ok());
        // 15 and 17 bytes.
        assert!(decode_key("AAECAwQFBgcICQoLDA0O").unwrap_err().contains("15 bytes"));
        assert!(decode_key("AAECAwQFBgcICQoLDA0ODxA=").unwrap_err().contains("17 bytes"));
        assert!(decode_key("not base64!").is_err());
        assert!(decode_key("").is_err());
    }

    #[test]
    fn replies_print() {
        let line = |reply: Reply| serde_json::from_str::<Value>(&reply.to_line(12.3456789)).unwrap();
        assert_eq!(
            line(Reply::Hello {
                protocol: 1,
                engine: "0.1.0",
                codecs: vec!["H264"],
                sources: vec!["file"]
            }),
            json!({"hello": {"protocol": 1, "engine": "0.1.0", "codecs": ["H264"], "sources": ["file"], "t_ms": 12.346}})
        );
        assert_eq!(line(Reply::Connected {}), json!({"connected": {"t_ms": 12.346}}));
        assert_eq!(
            line(Reply::IceState { state: IceState::Checking }),
            json!({"ice_state": {"state": "checking", "t_ms": 12.346}})
        );
        assert_eq!(
            line(Reply::KeyFrameRequest { kind: KeyFrameKind::Pli }),
            json!({"key_frame_request": {"kind": "pli", "t_ms": 12.346}})
        );
        assert_eq!(
            line(Reply::Error { message: "unknown message dance".into(), fatal: false }),
            json!({"error": {"message": "unknown message dance", "fatal": false, "t_ms": 12.346}})
        );
        assert_eq!(line(Reply::Closed { reason: "end_of_input" }), json!({"closed": {"reason": "end_of_input", "t_ms": 12.346}}));
        assert_eq!(
            line(Reply::Opened { dtls_parameters: json!({"role": "client"}), rtp_parameters: json!({"mid": "0"}) }),
            json!({"opened": {"dtls_parameters": {"role": "client"}, "rtp_parameters": {"mid": "0"}, "t_ms": 12.346}})
        );

        let stats = line(Reply::Stats(Stats { frames_sent: 30, ..Stats::default() }));
        let fields = stats["stats"].as_object().unwrap();
        assert_eq!(fields["frames_sent"], 30);
        for name in [
            "ms_since_open", "key_frames_sent", "frames_dropped_source", "frames_dropped_encryption",
            "media_packets_sent", "media_bytes_sent", "rtx_packets_sent", "queued_packets",
            "bandwidth_estimate_bps", "target_bitrate_bps", "rtt_ms", "loss_fraction", "nacks",
            "plis", "firs", "dtls_version", "t_ms", "queued_packets_max", "queued_bytes",
            "queued_bytes_max", "queued_ms_max", "frames_skipped_backlog", "encoder_bitrate_bps",
            "encoder_output_bps", "encode_ms_median", "encode_ms_max", "key_frames_forced",
            "frames_skipped_rate", "frame_rate_divisor", "key_frames_repeated", "capture_frames_delivered",
            "capture_frames_taken", "capture_frames_dropped_rate", "capture_buffer_path",
            "capture_delay_ms_median", "capture_delay_ms_max",
        ] {
            assert!(fields.contains_key(name), "{name}");
        }
    }
}
