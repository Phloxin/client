// The node half: a real mediasoup worker, WebRtcServer, router and transports, set up the way
// crates/pylon-sfu sets them up for a client.

use std::{
    net::{IpAddr, Ipv4Addr, UdpSocket},
    num::NonZeroU32,
};

use mediasoup::prelude::*;
use mediasoup::types::data_structures::{ListenInfo, Protocol as MsProtocol};
use mediasoup::types::rtp_parameters::{
    MediaKind as MsMediaKind, MimeTypeVideo, RtpCodecCapability, RtpCodecParametersParameters,
    RtpParameters,
};
use mediasoup::webrtc_server::{WebRtcServerListenInfos, WebRtcServerOptions};
use serde_json::{Value, json};

// Same as the node (crates/pylon-sfu/src/config/transports.rs).
pub const MAX_CLIENT_UPLOAD_BITRATE: u64 = 25_000_000;
const DEFAULT_TRANSPORT_BITRATE: u64 = 10_000_000;
const VIDEO_KEY_FRAME_REQUEST_DELAY_MS: u32 = 1_000;

/// The address the node's WebRtcServer listens on: `PROBE_LISTEN_IP`, default 127.0.0.1. Another
/// address lets a sidecar on another machine reach it (.plans/native-media-engine-m7a-windows-bringup.md, W5).
fn listen_ip() -> IpAddr {
    crate::env("PROBE_LISTEN_IP", IpAddr::V4(Ipv4Addr::LOCALHOST))
}

fn unused_udp_port(ip: IpAddr) -> u16 {
    UdpSocket::bind((ip, 0))
        .expect("bind")
        .local_addr()
        .unwrap()
        .port()
}

fn loopback(port: Option<u16>) -> ListenInfo {
    listen_on(IpAddr::V4(Ipv4Addr::LOCALHOST), port)
}

fn listen_on(ip: IpAddr, port: Option<u16>) -> ListenInfo {
    ListenInfo {
        protocol: MsProtocol::Udp,
        ip,
        announced_address: None,
        expose_internal_ip: false,
        port,
        port_range: None,
        flags: None,
        send_buffer_size: None,
        recv_buffer_size: None,
    }
}

/// A worker, its WebRtcServer and one router.
pub struct Node {
    _manager: WorkerManager,
    _worker: Worker,
    server: WebRtcServer,
    pub router: Router,
}

impl Node {
    pub async fn start() -> Node {
        Self::start_with(false).await
    }

    /// With `vp8`, the router also offers VP8 (for Chromium as a sender, M5a D26).
    pub async fn start_with(vp8: bool) -> Node {
        let manager = WorkerManager::new();
        let worker = manager
            .create_worker(WorkerSettings::default())
            .await
            .expect("worker");
        let ip = listen_ip();
        let server = worker
            .create_webrtc_server(WebRtcServerOptions::new(WebRtcServerListenInfos::new(
                listen_on(ip, Some(unused_udp_port(ip))),
            )))
            .await
            .expect("webrtc server");
        // AV1 as crates/pylon-sfu/src/config/router.rs declares it, and as there before H264
        // (AV1 step 2, Q11).
        let mut codecs = vec![RtpCodecCapability::Video {
            mime_type: MimeTypeVideo::AV1,
            preferred_payload_type: None,
            clock_rate: NonZeroU32::new(90000).unwrap(),
            parameters: RtpCodecParametersParameters::from([
                ("profile", 0_u32.into()),
                ("level-idx", 13_u32.into()),
                ("tier", 0_u32.into()),
            ]),
            rtcp_feedback: vec![],
        }, RtpCodecCapability::Video {
            mime_type: MimeTypeVideo::H264,
            preferred_payload_type: None,
            clock_rate: NonZeroU32::new(90000).unwrap(),
            parameters: RtpCodecParametersParameters::from([
                ("profile-level-id", "420034".into()),
                ("level-asymmetry-allowed", 1_u32.into()),
                ("packetization-mode", 1_u32.into()),
            ]),
            rtcp_feedback: vec![],
        }];
        if vp8 {
            codecs.insert(
                0,
                RtpCodecCapability::Video {
                    mime_type: MimeTypeVideo::Vp8,
                    preferred_payload_type: None,
                    clock_rate: NonZeroU32::new(90000).unwrap(),
                    parameters: RtpCodecParametersParameters::default(),
                    rtcp_feedback: vec![],
                },
            );
        }
        let router = worker
            .create_router(RouterOptions::new(codecs))
            .await
            .expect("router");
        Node {
            _manager: manager,
            _worker: worker,
            server,
            router,
        }
    }

    /// The router's capabilities as a client gets them.
    pub fn capabilities(&self) -> Value {
        serde_json::to_value(self.router.rtp_capabilities()).unwrap()
    }

    /// A client's send transport (`ClientTransports::new`, producer side).
    pub async fn send_transport(&self) -> WebRtcTransport {
        let mut options = WebRtcTransportOptions::new_with_server(self.server.clone());
        options.initial_available_outgoing_bitrate = MAX_CLIENT_UPLOAD_BITRATE;
        options.enable_udp = true;
        options.enable_tcp = true;
        options.prefer_udp = true;
        let transport = self
            .router
            .create_webrtc_transport(options)
            .await
            .expect("send transport");
        transport
            .set_max_incoming_bitrate(MAX_CLIENT_UPLOAD_BITRATE)
            .await
            .expect("max incoming bitrate");
        transport
    }

    /// A client's receive transport (`ClientTransports::new`, consumer side).
    pub async fn recv_transport(&self) -> WebRtcTransport {
        let mut options = WebRtcTransportOptions::new_with_server(self.server.clone());
        options.initial_available_outgoing_bitrate = DEFAULT_TRANSPORT_BITRATE;
        options.enable_udp = true;
        options.enable_tcp = true;
        options.prefer_udp = true;
        self.router
            .create_webrtc_transport(options)
            .await
            .expect("recv transport")
    }

    /// A plain RTP transport that sends to `port` on loopback.
    pub async fn plain_recv_transport(&self, port: u16) -> PlainTransport {
        let mut plain = PlainTransportOptions::new(loopback(None));
        plain.rtcp_mux = true;
        let transport = self
            .router
            .create_plain_transport(plain)
            .await
            .expect("recv transport");
        transport
            .connect(PlainTransportRemoteParameters {
                ip: Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
                port: Some(port),
                rtcp_port: None,
                srtp_parameters: None,
            })
            .await
            .expect("connect recv transport");
        transport
    }
}

/// What goes over the wire to a client in `RoutingParams`, in the shape the engine reads.
pub fn transport_parameters(transport: &WebRtcTransport) -> Value {
    json!({
        "id": transport.id(),
        "ice_parameters": transport.ice_parameters(),
        "ice_candidates": transport.ice_candidates(),
        "dtls_parameters": transport.dtls_parameters(),
    })
}

/// `CreateSource` on the send transport.
pub async fn produce(transport: &WebRtcTransport, rtp_parameters: Value) -> Producer {
    let rtp_parameters: RtpParameters =
        serde_json::from_value(rtp_parameters).expect("rtp parameters");
    let mut options = ProducerOptions::new(MsMediaKind::Video, rtp_parameters);
    options.key_frame_request_delay = VIDEO_KEY_FRAME_REQUEST_DELAY_MS;
    transport.produce(options).await.expect("producer")
}
