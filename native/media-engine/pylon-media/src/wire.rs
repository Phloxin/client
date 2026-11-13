// What the engine reads from the node's JSON and what it signals back: payload types and header
// extension ids from the router's capabilities, the transport's ICE and DTLS parameters, and the
// RTP parameters for `CreateSource`.

use std::net::{IpAddr, SocketAddr};

use serde_json::{Value, json};

use crate::{Error, VideoCodec, av1::DEPENDENCY_DESCRIPTOR_URI};

pub(crate) const MID: &str = "0";

const URI_MID: &str = "urn:ietf:params:rtp-hdrext:sdes:mid";
const URI_ABS_SEND_TIME: &str = "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time";
const URI_TWCC: &str = "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01";

/// What the engine and the signalled RTP parameters must agree on.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Wire {
    pub codec: VideoCodec,
    pub pt: u8,
    pub rtx_pt: u8,
    pub mid_id: u8,
    pub abs_send_time_id: u8,
    pub twcc_id: u8,
    pub format: Format,
    codec_parameters: Value,
    rtcp_feedback: Value,
}

/// The codec's own parameters, as the router gives them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Format {
    H264 { profile_level_id: u32 },
    /// The Dependency Descriptor's extension id comes with AV1 (Q3).
    Av1 { profile: u8, level_idx: u8, tier: u8, dependency_descriptor_id: u8 },
}

/// An AV1 parameter of the router's codec (`profile`, `level-idx`, `tier`), a number or a
/// numeric string. Absent, the value the AV1 RTP specification infers ("SDP Parameters").
fn av1_parameter(parameters: &Value, name: &str, absent: u8) -> Result<u8, Error> {
    let value = &parameters[name];
    if value.is_null() {
        return Ok(absent);
    }
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        .and_then(|v| u8::try_from(v).ok())
        .ok_or_else(|| Error::invalid(format!("AV1 has no usable {name}")))
}

fn payload_type(codec: &Value, what: &str) -> Result<u8, Error> {
    codec["preferredPayloadType"]
        .as_u64()
        .filter(|pt| *pt < 128)
        .map(|pt| pt as u8)
        .ok_or_else(|| Error::invalid(format!("{what} has no usable preferredPayloadType")))
}

fn is_mime(codec: &Value, mime: &str) -> bool {
    codec["mimeType"].as_str().is_some_and(|m| m.eq_ignore_ascii_case(mime))
}

impl Wire {
    /// The entry of `codec` and its RTX in the router's capabilities (Q3).
    pub fn from_router_capabilities(caps: &Value, codec: VideoCodec) -> Result<Self, Error> {
        let name = codec.name();
        let codecs = caps["codecs"]
            .as_array()
            .ok_or_else(|| Error::invalid("router capabilities have no codecs"))?;
        let entry = codecs
            .iter()
            .find(|c| is_mime(c, codec.mime()))
            .ok_or_else(|| Error::invalid(format!("router has no {name}")))?;
        let pt = payload_type(entry, name)?;
        let rtx = codecs
            .iter()
            .find(|c| is_mime(c, "video/rtx") && c["parameters"]["apt"].as_u64() == Some(pt as u64))
            .ok_or_else(|| Error::invalid(format!("router has no RTX for {name}")))?;
        let rtx_pt = payload_type(rtx, "RTX")?;

        let extensions = caps["headerExtensions"]
            .as_array()
            .ok_or_else(|| Error::invalid("router capabilities have no headerExtensions"))?;
        let ext_id = |uri: &str| {
            extensions
                .iter()
                .find(|e| e["uri"] == uri && e["kind"] == "video")
                .and_then(|e| e["preferredId"].as_u64())
                // One-byte header extension ids, which str0m takes as 1 to 14.
                .filter(|id| (1..=14).contains(id))
                .map(|id| id as u8)
                .ok_or_else(|| Error::invalid(format!("router lacks header extension {uri}")))
        };

        let parameters = &entry["parameters"];
        let format = match codec {
            VideoCodec::H264 => Format::H264 {
                profile_level_id: parameters["profile-level-id"]
                    .as_str()
                    .and_then(|s| u32::from_str_radix(s, 16).ok())
                    .ok_or_else(|| Error::invalid("H264 has no usable profile-level-id"))?,
            },
            VideoCodec::Av1 => Format::Av1 {
                profile: av1_parameter(parameters, "profile", 0)?,
                level_idx: av1_parameter(parameters, "level-idx", 5)?,
                tier: av1_parameter(parameters, "tier", 0)?,
                // mediasoup finds AV1 key frames only through it.
                dependency_descriptor_id: ext_id(DEPENDENCY_DESCRIPTOR_URI)?,
            },
        };

        Ok(Wire {
            codec,
            pt,
            rtx_pt,
            mid_id: ext_id(URI_MID)?,
            abs_send_time_id: ext_id(URI_ABS_SEND_TIME)?,
            twcc_id: ext_id(URI_TWCC)?,
            format,
            codec_parameters: parameters.clone(),
            rtcp_feedback: entry["rtcpFeedback"].clone(),
        })
    }

    /// The RTP parameters a client sends in `CreateSource`.
    pub fn rtp_parameters(&self, ssrc: u32, rtx_ssrc: u32, cname: &str) -> Value {
        let mut extensions = vec![
            json!({ "uri": URI_MID, "id": self.mid_id, "encrypt": false, "parameters": {} }),
            json!({ "uri": URI_ABS_SEND_TIME, "id": self.abs_send_time_id, "encrypt": false, "parameters": {} }),
            json!({ "uri": URI_TWCC, "id": self.twcc_id, "encrypt": false, "parameters": {} }),
        ];
        if let Format::Av1 { dependency_descriptor_id, .. } = self.format {
            extensions.push(json!({ "uri": DEPENDENCY_DESCRIPTOR_URI, "id": dependency_descriptor_id, "encrypt": false, "parameters": {} }));
        }
        json!({
            "mid": MID,
            "codecs": [
                {
                    "mimeType": self.codec.mime(),
                    "payloadType": self.pt,
                    "clockRate": 90000,
                    "parameters": self.codec_parameters,
                    "rtcpFeedback": self.rtcp_feedback,
                },
                {
                    "mimeType": "video/rtx",
                    "payloadType": self.rtx_pt,
                    "clockRate": 90000,
                    "parameters": { "apt": self.pt },
                    "rtcpFeedback": [],
                },
            ],
            "headerExtensions": extensions,
            "encodings": [ { "ssrc": ssrc, "rtx": { "ssrc": rtx_ssrc } } ],
            "rtcp": { "cname": cname, "reducedSize": true },
        })
    }
}

/// The parts of the node's transport parameters the engine uses.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RemoteTransport {
    pub ufrag: String,
    pub pass: String,
    /// The node's first UDP candidate.
    pub candidate: SocketAddr,
    /// The sha-256 fingerprint of the node's DTLS certificate.
    pub fingerprint: Vec<u8>,
}

impl RemoteTransport {
    pub fn from_json(transport: &Value) -> Result<Self, Error> {
        let ice = &transport["ice_parameters"];
        let text = |value: &Value, what: &str| {
            value
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| Error::invalid(format!("transport has no {what}")))
        };
        let ufrag = text(&ice["usernameFragment"], "ice_parameters.usernameFragment")?;
        let pass = text(&ice["password"], "ice_parameters.password")?;

        let candidates = transport["ice_candidates"]
            .as_array()
            .ok_or_else(|| Error::invalid("transport has no ice_candidates"))?;
        let udp = candidates
            .iter()
            .find(|c| c["protocol"] == "udp")
            .ok_or_else(|| Error::invalid("transport has no UDP candidate"))?;
        let ip: IpAddr = udp["address"]
            .as_str()
            .and_then(|a| a.parse().ok())
            .ok_or_else(|| Error::invalid("UDP candidate has no usable address"))?;
        let port = udp["port"]
            .as_u64()
            .and_then(|p| u16::try_from(p).ok())
            .filter(|p| *p != 0)
            .ok_or_else(|| Error::invalid("UDP candidate has no usable port"))?;

        let fingerprint = transport["dtls_parameters"]["fingerprints"]
            .as_array()
            .ok_or_else(|| Error::invalid("transport has no dtls_parameters.fingerprints"))?
            .iter()
            .find(|f| f["algorithm"] == "sha-256")
            .and_then(|f| f["value"].as_str())
            .ok_or_else(|| Error::invalid("transport has no sha-256 fingerprint"))?;
        let fingerprint = parse_fingerprint(fingerprint)
            .ok_or_else(|| Error::invalid("sha-256 fingerprint is not 32 hex bytes"))?;

        Ok(RemoteTransport {
            ufrag,
            pass,
            candidate: SocketAddr::new(ip, port),
            fingerprint,
        })
    }
}

fn parse_fingerprint(value: &str) -> Option<Vec<u8>> {
    let bytes = value
        .split(':')
        .map(|b| (b.len() == 2).then(|| u8::from_str_radix(b, 16).ok()).flatten())
        .collect::<Option<Vec<u8>>>()?;
    (bytes.len() == 32).then_some(bytes)
}

/// The engine's DTLS parameters as a client sends them in `ConnectTransport`.
pub(crate) fn dtls_parameters(hash_func: &str, bytes: &[u8]) -> Value {
    let value = bytes.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":");
    json!({
        "role": "client",
        "fingerprints": [ { "algorithm": hash_func, "value": value } ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps() -> Value {
        serde_json::from_str(include_str!("../testdata/router_rtp_capabilities.json")).unwrap()
    }

    fn transport() -> Value {
        serde_json::from_str(include_str!("../testdata/transport.json")).unwrap()
    }

    /// The capabilities of the probe's node (mediasoup 0.33.1) with AV1 as the backend declares it
    /// and before H264, as the backend has them: AV1 at 100, H264 at 102.
    fn caps_av1() -> Value {
        serde_json::from_str(include_str!("../testdata/router_rtp_capabilities_av1.json")).unwrap()
    }

    #[test]
    fn wire_from_real_capabilities() {
        let wire = Wire::from_router_capabilities(&caps(), VideoCodec::H264).unwrap();
        assert_eq!((wire.pt, wire.rtx_pt), (100, 101));
        assert_eq!((wire.mid_id, wire.abs_send_time_id, wire.twcc_id), (1, 4, 5));
        assert_eq!(wire.format, Format::H264 { profile_level_id: 0x420034 });

        let rtp = wire.rtp_parameters(7, 8, "cname");
        assert_eq!(rtp["mid"], "0");
        assert_eq!(rtp["codecs"][0]["mimeType"], "video/H264");
        assert_eq!(rtp["codecs"][0]["payloadType"], 100);
        assert_eq!(rtp["codecs"][0]["parameters"]["packetization-mode"], 1);
        assert_eq!(rtp["codecs"][1]["parameters"]["apt"], 100);
        assert_eq!(rtp["encodings"][0]["ssrc"], 7);
        assert_eq!(rtp["encodings"][0]["rtx"]["ssrc"], 8);
        assert_eq!(rtp["rtcp"]["cname"], "cname");
        // H264 signals what it did before AV1: three extensions.
        let uris: Vec<&str> = rtp["headerExtensions"].as_array().unwrap().iter().map(|e| e["uri"].as_str().unwrap()).collect();
        assert_eq!(uris, vec![URI_MID, URI_ABS_SEND_TIME, URI_TWCC]);
        // A router without AV1 has none to give.
        assert!(Wire::from_router_capabilities(&caps(), VideoCodec::Av1).is_err());
    }

    #[test]
    fn wire_with_av1() {
        let caps = caps_av1();
        let av1 = Wire::from_router_capabilities(&caps, VideoCodec::Av1).unwrap();
        let h264 = Wire::from_router_capabilities(&caps, VideoCodec::H264).unwrap();
        // Each codec with its own RTX, whatever the order of the router's list.
        let pt_of = |mime: &str| caps["codecs"].as_array().unwrap().iter().find(|c| c["mimeType"] == mime).unwrap()["preferredPayloadType"].as_u64().unwrap() as u8;
        let rtx_of = |pt: u8| {
            caps["codecs"].as_array().unwrap().iter().find(|c| c["mimeType"] == "video/rtx" && c["parameters"]["apt"] == pt).unwrap()["preferredPayloadType"].as_u64().unwrap() as u8
        };
        assert_eq!((av1.pt, av1.rtx_pt), (pt_of("video/AV1"), rtx_of(pt_of("video/AV1"))));
        assert_eq!((h264.pt, h264.rtx_pt), (pt_of("video/H264"), rtx_of(pt_of("video/H264"))));
        assert_ne!(av1.pt, h264.pt);
        assert_eq!(av1.format, Format::Av1 { profile: 0, level_idx: 13, tier: 0, dependency_descriptor_id: 7 });
        assert!(matches!(h264.format, Format::H264 { profile_level_id: 0x420034 }));

        let rtp = av1.rtp_parameters(7, 8, "cname");
        assert_eq!(rtp["codecs"][0]["mimeType"], "video/AV1");
        assert_eq!(rtp["codecs"][0]["payloadType"], av1.pt);
        assert_eq!(rtp["codecs"][0]["clockRate"], 90000);
        assert_eq!(rtp["codecs"][0]["parameters"], json!({ "profile": 0, "level-idx": 13, "tier": 0 }));
        assert_eq!(rtp["codecs"][1]["mimeType"], "video/rtx");
        assert_eq!(rtp["codecs"][1]["parameters"]["apt"], av1.pt);
        let ext = rtp["headerExtensions"].as_array().unwrap();
        assert_eq!(ext.len(), 4);
        assert_eq!(ext[3], json!({ "uri": DEPENDENCY_DESCRIPTOR_URI, "id": 7, "encrypt": false, "parameters": {} }));
        let h264_ext = h264.rtp_parameters(7, 8, "cname")["headerExtensions"].as_array().unwrap().len();
        assert_eq!(h264_ext, 3);

        // AV1 needs the Dependency Descriptor from the router.
        let mut no_dd = caps.clone();
        no_dd["headerExtensions"].as_array_mut().unwrap().retain(|e| e["uri"] != DEPENDENCY_DESCRIPTOR_URI);
        assert!(Wire::from_router_capabilities(&no_dd, VideoCodec::Av1).is_err());
        assert!(Wire::from_router_capabilities(&no_dd, VideoCodec::H264).is_ok());
        // Absent parameters are what the format infers, unusable ones are errors.
        let mut bare = caps.clone();
        let entry = bare["codecs"].as_array_mut().unwrap().iter_mut().find(|c| c["mimeType"] == "video/AV1").unwrap();
        entry["parameters"] = json!({ "level-idx": "8" });
        let wire = Wire::from_router_capabilities(&bare, VideoCodec::Av1).unwrap();
        assert_eq!(wire.format, Format::Av1 { profile: 0, level_idx: 8, tier: 0, dependency_descriptor_id: 7 });
        entry_set(&mut bare, json!({ "profile": 300 }));
        assert!(Wire::from_router_capabilities(&bare, VideoCodec::Av1).is_err());
        entry_set(&mut bare, json!({ "tier": "high" }));
        assert!(Wire::from_router_capabilities(&bare, VideoCodec::Av1).is_err());
        let mut no_rtx = caps.clone();
        no_rtx["codecs"].as_array_mut().unwrap().retain(|c| !(c["mimeType"] == "video/rtx" && c["parameters"]["apt"] == av1.pt));
        assert!(Wire::from_router_capabilities(&no_rtx, VideoCodec::Av1).is_err());
    }

    fn entry_set(caps: &mut Value, parameters: Value) {
        let entry = caps["codecs"].as_array_mut().unwrap().iter_mut().find(|c| c["mimeType"] == "video/AV1").unwrap();
        entry["parameters"] = parameters;
    }

    #[test]
    fn wire_errors_without_panicking() {
        assert!(Wire::from_router_capabilities(&json!({}), VideoCodec::H264).is_err());
        assert!(Wire::from_router_capabilities(&json!(null), VideoCodec::H264).is_err());
        assert!(Wire::from_router_capabilities(&json!(null), VideoCodec::Av1).is_err());

        let mut no_rtx = caps();
        no_rtx["codecs"].as_array_mut().unwrap().retain(|c| c["mimeType"] != "video/rtx");
        assert!(Wire::from_router_capabilities(&no_rtx, VideoCodec::H264).is_err());

        let mut no_twcc = caps();
        no_twcc["headerExtensions"]
            .as_array_mut()
            .unwrap()
            .retain(|e| e["uri"] != URI_TWCC);
        assert!(Wire::from_router_capabilities(&no_twcc, VideoCodec::H264).is_err());

        let mut bad_pt = caps();
        bad_pt["codecs"][0]["preferredPayloadType"] = json!(300);
        assert!(Wire::from_router_capabilities(&bad_pt, VideoCodec::H264).is_err());
    }

    #[test]
    fn transport_as_the_node_sends_it() {
        let remote = RemoteTransport::from_json(&transport()).unwrap();
        assert_eq!(remote.ufrag, "kef0zoir3oudxfrpr4zod2sdjjvo93ti");
        assert_eq!(remote.pass, "en8zibszzjtbk4burerkc9lavhec19l5");
        assert_eq!(remote.candidate, "127.0.0.1:39627".parse().unwrap());
        assert_eq!(remote.fingerprint.len(), 32);
        assert_eq!(remote.fingerprint[..3], [0xDB, 0x0D, 0x4E]);
    }

    #[test]
    fn tcp_candidates_are_skipped() {
        let mut t = transport();
        let udp = t["ice_candidates"][0].clone();
        let mut tcp = udp.clone();
        tcp["protocol"] = json!("tcp");
        tcp["port"] = json!(4443);
        t["ice_candidates"] = json!([tcp, udp]);
        assert_eq!(RemoteTransport::from_json(&t).unwrap().candidate.port(), 39627);

        t["ice_candidates"] = json!([tcp]);
        assert!(RemoteTransport::from_json(&t).is_err());
    }

    #[test]
    fn bad_transports_are_errors() {
        let base = transport();
        let mut cases = Vec::new();
        for (path, value) in [
            ("/ice_parameters/password", json!(null)),
            ("/ice_parameters/usernameFragment", json!(5)),
            ("/ice_candidates", json!("none")),
            ("/ice_candidates/0/address", json!("not an ip")),
            ("/ice_candidates/0/port", json!(70000)),
            ("/dtls_parameters/fingerprints/2/value", json!("DB:0D")),
            ("/dtls_parameters/fingerprints/2/value", json!("zz:".repeat(31) + "zz")),
            ("/dtls_parameters/fingerprints/2/algorithm", json!("sha-999")),
        ] {
            let mut t = base.clone();
            *t.pointer_mut(path).unwrap() = value;
            cases.push(t);
        }
        cases.push(json!({}));
        cases.push(json!([1, 2, 3]));
        for case in cases {
            assert!(RemoteTransport::from_json(&case).is_err(), "{case}");
        }
    }

    #[test]
    fn dtls_parameters_shape() {
        let p = dtls_parameters("sha-256", &[0xAB, 0x01]);
        assert_eq!(p, json!({ "role": "client", "fingerprints": [ { "algorithm": "sha-256", "value": "AB:01" } ] }));
    }
}
