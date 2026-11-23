// One sending session: str0m in RTP mode through the direct API on a transport thread of its
// own, fed by a `Source` on a second thread.

use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender, TryRecvError},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

use pylon_e2ee::{Codec, Encryptor};
use serde::Serialize;
use str0m::{
    Candidate, Event as RtcEvent, Input, Output, Rtc, IceConnectionState,
    bwe::{Bitrate, BweKind},
    config::Fingerprint,
    format::{Codec as RtpCodec, FormatParams},
    ice::IceCreds,
    media::{Frequency, KeyframeRequestKind, MediaKind, Mid},
    net::{Protocol, Receive, Transmit},
    rtp::{Extension, ExtensionMap, ExtensionSerializer, ExtensionValues, RtpWrite, SeqNo, Ssrc},
};

use crate::{
    Error, KEY_LEN, OpenParams, Opened, VideoCodec,
    av1::{self, DEPENDENCY_DESCRIPTOR_URI, DependencyDescriptor},
    h264::{self, PAYLOAD_LIMIT},
    params,
    source::{EncodedFrame, Source, SourceControl, frame_channel},
    wire::{self, Format, MID, RemoteTransport, Wire},
};

/// The Dependency Descriptor of one packet, as `RtpWrite::ext_vals` carries it to the
/// serializer (Q4).
#[derive(Clone, Debug, PartialEq, Eq)]
struct DependencyDescriptorBytes(Vec<u8>);

/// Writes the engine's own Dependency Descriptor into the RTP header (AV1 only).
#[derive(Debug)]
struct DependencyDescriptorSerializer;

impl ExtensionSerializer for DependencyDescriptorSerializer {
    fn write_to(&self, buf: &mut [u8], ev: &ExtensionValues) -> usize {
        match ev.user_values.get::<DependencyDescriptorBytes>() {
            Some(DependencyDescriptorBytes(bytes)) if bytes.len() <= buf.len() => {
                buf[..bytes.len()].copy_from_slice(bytes);
                bytes.len()
            }
            _ => 0,
        }
    }

    // Only sent, never read.
    fn parse_value(&self, _buf: &[u8], _ev: &mut ExtensionValues) -> bool {
        false
    }

    fn is_video(&self) -> bool {
        true
    }

    fn is_audio(&self) -> bool {
        false
    }

    // Three or nine bytes, so the one-byte form always does.
    fn requires_two_byte_form(&self, ev: &ExtensionValues) -> bool {
        ev.user_values.get::<DependencyDescriptorBytes>().is_some_and(|d| d.0.len() > 16)
    }
}

/// Frames that wait between the source and the transport thread before pushes fail.
const FRAME_QUEUE: usize = 8;
/// The minimum passed to the bandwidth estimator. Zero, so str0m pads only its own floor of
/// 50 kbps (`PADDING_TARGET` in its pacer) when there is nothing to send (M5a section 10, option 3).
const MIN_BITRATE: Bitrate = Bitrate::ZERO;
const STATS_INTERVAL: Duration = Duration::from_secs(1);
/// The longest the I/O loop sleeps.
const MAX_SLEEP: Duration = Duration::from_micros(200);

/// The minimum passed to the estimator for a share whose source asked to sustain `sustain` toward a
/// larger picture (smooth U1): that, never over the share's maximum; zero when nothing is asked.
fn minimum(sustain: u64, max: u64) -> Bitrate {
    if sustain == 0 { MIN_BITRATE } else { Bitrate::bps(sustain.min(max)) }
}

/// What the source asks the transport to sustain, as last handed to str0m (smooth U2).
#[derive(Debug, Default)]
struct Sustain {
    asked: u64,
}

impl Sustain {
    /// The minimum to hand to str0m when `asked` changed, `None` when it is as before.
    fn changed(&mut self, asked: u64, max: u64) -> Option<Bitrate> {
        if asked == self.asked {
            return None;
        }
        self.asked = asked;
        Some(minimum(asked, max))
    }
}

/// The ICE connection state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IceState {
    New,
    Checking,
    Connected,
    Completed,
    Disconnected,
}

/// What kind of key frame request came in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyFrameKind {
    Pli,
    Fir,
}

/// Why an engine stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CloseReason {
    /// `close` was called or the `Engine` was dropped.
    Requested,
    /// The transport is gone (str0m stopped).
    Disconnected,
    /// A fatal error, reported just before.
    Error,
}

/// The engine's counters, once a second after connecting.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Stats {
    pub ms_since_open: u64,
    pub frames_sent: u64,
    pub key_frames_sent: u64,
    pub frames_dropped_source: u64,
    pub frames_dropped_encryption: u64,
    pub media_packets_sent: u64,
    pub media_bytes_sent: u64,
    pub rtx_packets_sent: u64,
    /// Bytes of those on the socket, retransmissions and padding (smooth U3): str0m does not count
    /// its padding on its own.
    pub rtx_bytes_sent: u64,
    /// The rate str0m is asked to sustain with media and padding, 0 for none (smooth U1, U3).
    pub sustain_bitrate_bps: u64,
    /// Packets in str0m's send queue (media, resends, padding), from `StreamTx::queue_info`.
    pub queued_packets: u64,
    /// The highest `queued_packets` since the last statistics.
    pub queued_packets_max: u64,
    /// Bytes in the same queue now, and the highest since the last statistics.
    pub queued_bytes: u64,
    pub queued_bytes_max: u64,
    /// The highest queue since the last statistics in milliseconds of the target bitrate.
    pub queued_ms_max: u64,
    pub bandwidth_estimate_bps: Option<u64>,
    pub target_bitrate_bps: u64,
    /// Frames the source did not encode because the queue was too deep.
    pub frames_skipped_backlog: u64,
    /// Frames the source did not encode because the frame rate gave way, and the current N
    /// (one frame in N encoded).
    pub frames_skipped_rate: u64,
    pub frame_rate_divisor: Option<u32>,
    /// The size the encoder runs at now, `None` for sources without an encoder or before it
    /// opened, and the steps of that size down and up on a tight link, in all (smooth S10).
    pub encoded_width: Option<u32>,
    pub encoded_height: Option<u32>,
    pub size_steps_down: u64,
    pub size_steps_up: u64,
    /// The encoder's configured bitrate and what it produced over the last second.
    pub encoder_bitrate_bps: Option<u64>,
    pub encoder_output_bps: Option<u64>,
    /// Encode time per frame since the last statistics.
    pub encode_ms_median: Option<f64>,
    pub encode_ms_max: Option<f64>,
    /// Key frames the source made because one was asked for.
    pub key_frames_forced: u64,
    /// Key frames made from the kept frame because nothing new came (M5b D6).
    pub key_frames_repeated: u64,
    /// A screen capture's counters (M5b D9), `None` for other sources: frames the compositor
    /// delivered, frames handed to the encoder, frames a newer one replaced, the buffer path
    /// (`dmabuf` or `memory`), and the delay from a frame arriving to the encoder taking it
    /// since the last statistics.
    pub capture_frames_delivered: Option<u64>,
    pub capture_frames_taken: Option<u64>,
    pub capture_frames_dropped_rate: Option<u64>,
    pub capture_buffer_path: Option<&'static str>,
    pub capture_delay_ms_median: Option<f64>,
    pub capture_delay_ms_max: Option<f64>,
    /// The time between frames sent by their capture times since the last statistics (the
    /// timeline a viewer plays back), `None` with fewer than two (smooth A1.4).
    pub frame_interval_ms_median: Option<f64>,
    pub frame_interval_ms_p95: Option<f64>,
    pub frame_interval_ms_max: Option<f64>,
    /// Of those intervals, ones over 1.5 times the producer's interval times the divisor in
    /// force, in all.
    pub frame_gaps_long: u64,
    /// The time between frames handed to str0m since the last statistics, `None` with fewer
    /// than two.
    pub send_interval_ms_p95: Option<f64>,
    pub send_interval_ms_max: Option<f64>,
    /// Frames the capture timed by their arrival because the compositor gave no usable time
    /// (smooth T2), `None` for sources that do not capture.
    pub capture_frames_untimed: Option<u64>,
    pub rtt_ms: Option<f64>,
    pub loss_fraction: Option<f32>,
    pub nacks: u64,
    pub plis: u64,
    pub firs: u64,
    pub dtls_version: Option<String>,
}

/// What an engine reports.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    IceState(IceState),
    Connected,
    KeyFrameRequest(KeyFrameKind),
    Stats(Stats),
    Error { message: String, fatal: bool },
    Closed(CloseReason),
}

/// One encoded frame for the sharer's own preview, in the clear (smooth P2). It is the sharer's
/// screen: no `Debug`, never logged.
pub struct PreviewFrame {
    pub codec: VideoCodec,
    pub key: bool,
    /// The frame's capture time since the engine opened.
    pub t_ms: f64,
    pub data: Vec<u8>,
}

/// Takes the stream preview's frames on the transport thread (smooth P2). It must never wait:
/// false when it did not take the frame, which is then dropped for the preview only.
pub type PreviewTap = Box<dyn FnMut(PreviewFrame) -> bool + Send>;

/// After a frame the stream preview's tap did not take, a key frame is asked for at most this
/// often (fix E6).
const PREVIEW_ASK_SPACING: Duration = Duration::from_secs(5);

/// The stream preview's gate (smooth P3): nothing is handed over before a key frame, and after
/// a frame the tap did not take, nothing until the next key frame.
struct StreamPreview {
    tap: PreviewTap,
    waiting_for_key: bool,
    /// When a frame the tap did not take last asked for a key frame (fix E6).
    asked: Option<Instant>,
}

impl StreamPreview {
    /// Turned on: it waits for a key frame, and asks the source for one at once.
    fn on(tap: PreviewTap, control: &SourceControl) -> Self {
        control.want_key_frame();
        StreamPreview { tap, waiting_for_key: true, asked: None }
    }

    /// Whether a frame (a key frame or not) is to be handed over.
    fn wants(&self, key: bool) -> bool {
        key || !self.waiting_for_key
    }

    /// Hands a wanted frame over at `now`. One the tap did not take asks for a key frame, at
    /// most once every `PREVIEW_ASK_SPACING` (fix E6), under the source's 500 ms spacing.
    fn hand(&mut self, frame: PreviewFrame, control: &SourceControl, now: Instant) {
        let taken = (self.tap)(frame);
        self.waiting_for_key = !taken;
        if !taken && self.asked.is_none_or(|at| now.saturating_duration_since(at) >= PREVIEW_ASK_SPACING) {
            self.asked = Some(now);
            control.want_key_frame();
        }
    }
}

/// The RTP timestamps of one stream, from the frames' capture times.
#[derive(Debug)]
struct RtpClock {
    base: u32,
    first: Option<Instant>,
    /// 90 kHz ticks since `first` of the timestamp handed out last.
    last: Option<u128>,
}

impl RtpClock {
    fn new(base: u32) -> Self {
        RtpClock { base, first: None, last: None }
    }

    /// The RTP timestamp of a frame captured at `capture`: never one that is not after the last
    /// (fix E1, a second line of defence behind the pipeline's rule).
    fn at(&mut self, capture: Instant) -> u32 {
        let first = *self.first.get_or_insert(capture);
        let nanos = capture.saturating_duration_since(first).as_nanos();
        let mut ticks = (nanos * 90_000 + 500_000_000) / 1_000_000_000;
        if let Some(last) = self.last
            && ticks <= last
        {
            ticks = last + 1;
        }
        self.last = Some(ticks);
        self.base.wrapping_add(ticks as u32)
    }
}

enum Command {
    Start(Box<dyn Source>),
    SetKey(pylon_e2ee::Format, u8, [u8; KEY_LEN]),
    SetMaxBitrate(u64),
    DropMedia(u64),
    /// The stream preview on (with its tap) or off (smooth P2).
    StreamPreview(Option<PreviewTap>),
    Close,
}

/// One sending session.
pub struct Engine {
    commands: Sender<Command>,
    thread: Option<JoinHandle<()>>,
    encrypted: bool,
    started: bool,
}

fn random_u32() -> Result<u32, Error> {
    let mut bytes = [0u8; 4];
    getrandom::fill(&mut bytes).map_err(|e| Error::Io(format!("random: {e}")))?;
    Ok(u32::from_be_bytes(bytes))
}

/// SSRCs, first sequence number and timestamp base for one session.
struct Numbers {
    ssrc: u32,
    rtx_ssrc: u32,
    seq: u64,
    rtp_base: u32,
}

impl Numbers {
    fn pick() -> Result<Self, Error> {
        let nonzero = || loop {
            match random_u32() {
                Ok(0) => continue,
                other => break other,
            }
        };
        let ssrc = nonzero()?;
        let rtx_ssrc = loop {
            let candidate = nonzero()?;
            if candidate != ssrc {
                break candidate;
            }
        };
        Ok(Numbers {
            ssrc,
            rtx_ssrc,
            // Never 0: mediasoup takes a first sequence number of 0 as a wrap (parent plan 7.1).
            seq: (random_u32()? % 32767) as u64 + 1,
            rtp_base: random_u32()?,
        })
    }
}

/// The local address that reaches `remote`.
fn local_address_for(remote: SocketAddr) -> Result<IpAddr, Error> {
    // Connecting a throwaway UDP socket picks the route and sends nothing.
    let unspecified: IpAddr = match remote {
        SocketAddr::V4(_) => Ipv4Addr::UNSPECIFIED.into(),
        SocketAddr::V6(_) => Ipv6Addr::UNSPECIFIED.into(),
    };
    let probe = UdpSocket::bind(SocketAddr::new(unspecified, 0)).map_err(|e| Error::io("bind", e))?;
    probe.connect(remote).map_err(|e| Error::io(&format!("route to {remote}"), e))?;
    Ok(probe.local_addr().map_err(|e| Error::io("local address", e))?.ip())
}

impl Engine {
    /// Binds the socket and starts ICE and DTLS toward the node's transport.
    pub fn open(params: OpenParams) -> Result<(Engine, Opened, Receiver<Event>), Error> {
        let opened_at = Instant::now();
        let wire = Wire::from_router_capabilities(&params.router_rtp_capabilities, params.video.codec)?;
        let remote = RemoteTransport::from_json(&params.transport)?;
        params.video.check()?;
        let encryption = match &params.e2ee {
            None => None,
            Some(e2ee) => {
                let format = params::format(e2ee.format)?;
                let source = e2ee.source.to_source()?;
                let mut encryptor = Encryptor::new(e2ee.kid, e2ee.counter);
                encryptor.set_key(format, e2ee.epoch, &e2ee.key);
                Some((encryptor, source))
            }
        };
        let numbers = Numbers::pick()?;

        let local_ip = local_address_for(remote.candidate)?;
        let socket = UdpSocket::bind(SocketAddr::new(local_ip, 0)).map_err(|e| Error::io("bind", e))?;
        socket.set_nonblocking(true).map_err(|e| Error::io("non-blocking socket", e))?;
        let local = socket.local_addr().map_err(|e| Error::io("local address", e))?;
        let local_candidate = Candidate::host(local, "udp").map_err(|e| Error::invalid(format!("local candidate {local}: {e}")))?;
        let remote_candidate = Candidate::host(remote.candidate, "udp")
            .map_err(|e| Error::invalid(format!("remote candidate {}: {e}", remote.candidate)))?;

        let start = Bitrate::bps(params.video.start_bitrate);
        let max = Bitrate::bps(params.video.max_bitrate);

        let mut exts = ExtensionMap::empty();
        exts.set(wire.mid_id, Extension::RtpMid);
        exts.set(wire.abs_send_time_id, Extension::AbsoluteSendTime);
        exts.set(wire.twcc_id, Extension::TransportSequenceNumber);
        if let Format::Av1 { dependency_descriptor_id, .. } = wire.format {
            exts.set(dependency_descriptor_id, Extension::with_serializer(DEPENDENCY_DESCRIPTOR_URI, DependencyDescriptorSerializer));
        }
        let mut config = Rtc::builder()
            .set_crypto_provider(Arc::new(str0m::crypto::from_feature_flags()))
            .set_rtp_mode(true)
            .clear_codecs()
            .set_extension_map(exts)
            .enable_bwe(Some(start))
            .set_stats_interval(Some(STATS_INTERVAL));
        match wire.format {
            Format::H264 { profile_level_id } => {
                config.codec_config().add_h264(wire.pt.into(), Some(wire.rtx_pt.into()), true, profile_level_id);
            }
            // The general entry with the router's parameters (Q4).
            Format::Av1 { profile, level_idx, tier, .. } => config.codec_config().add_config(
                wire.pt.into(),
                Some(wire.rtx_pt.into()),
                RtpCodec::Av1,
                Frequency::NINETY_KHZ,
                None,
                FormatParams {
                    profile: Some(profile),
                    level_idx: Some(level_idx),
                    tier: Some(tier),
                    ..Default::default()
                },
            ),
        }
        let mut rtc = config.build(Instant::now());
        rtc.add_local_candidate(local_candidate);
        rtc.add_remote_candidate(remote_candidate);

        let (dtls_parameters, cname) = {
            let mut api = rtc.direct_api();
            // The node is ICE-lite, so the engine controls. It is also the DTLS client.
            api.set_ice_controlling(true);
            api.set_remote_ice_credentials(IceCreds {
                ufrag: remote.ufrag.clone(),
                pass: remote.pass.clone(),
            });
            api.set_remote_fingerprint(Fingerprint {
                hash_func: "sha-256".into(),
                bytes: remote.fingerprint.clone(),
            });
            api.start_dtls(true).map_err(|e| Error::invalid(format!("start DTLS: {e}")))?;

            let mid: Mid = MID.into();
            // str0m makes a random CNAME per media and sends it in SDES, so that is the one signalled.
            let cname = api.declare_media(mid, MediaKind::Video).cname().to_owned();
            api.declare_stream_tx(Ssrc::from(numbers.ssrc), Some(Ssrc::from(numbers.rtx_ssrc)), mid, None);

            let fingerprint = api.local_dtls_fingerprint();
            (wire::dtls_parameters(&fingerprint.hash_func, &fingerprint.bytes), cname)
        };
        rtc.bwe().set_bitrate(MIN_BITRATE, max);

        let opened = Opened {
            dtls_parameters,
            rtp_parameters: wire.rtp_parameters(numbers.ssrc, numbers.rtx_ssrc, &cname),
        };

        tracing::info!(
            local = %local,
            remote = %remote.candidate,
            pt = wire.pt,
            rtx_pt = wire.rtx_pt,
            ssrc = numbers.ssrc,
            rtx_ssrc = numbers.rtx_ssrc,
            first_seq = numbers.seq,
            encrypted = encryption.is_some(),
            start_bps = start.as_u64(),
            max_bps = max.as_u64(),
            codec = wire.codec.name(),
            "engine open"
        );

        let (commands, command_rx) = mpsc::channel();
        let (events, event_rx) = mpsc::channel();
        let encrypted = encryption.is_some();
        let control = Arc::new(SourceControl::default());
        control.set_target_bitrate(target(start.as_u64(), max.as_u64()));
        // The ladder steps up only to sizes the maximum carries (fix E2).
        control.set_max_bitrate(max.as_u64());
        let transport = Transport {
            rtc,
            socket,
            local,
            wire,
            ssrc: Ssrc::from(numbers.ssrc),
            seq: numbers.seq,
            rtp_clock: RtpClock::new(numbers.rtp_base),
            frame_number: 0,
            encryption,
            commands: command_rx,
            events,
            control,
            pending_source: None,
            source_thread: None,
            frames: None,
            source_dropped: Arc::new(AtomicU64::new(0)),
            opened_at,
            connected: false,
            next_stats: opened_at,
            drop_media: 0,
            start: start.as_u64(),
            max: max.as_u64(),
            estimate: None,
            stats: Stats::default(),
            queue: QueueSample::default(),
            queue_max: QueueSample::default(),
            encrypt_errors_logged: Vec::new(),
            last_send: None,
            send_intervals: Vec::new(),
            stream_preview: None,
            sustain: Sustain::default(),
        };
        let thread = std::thread::Builder::new()
            .name("pylon-media transport".into())
            .spawn(move || {
                let _priority = crate::priority::media_thread();
                transport.run()
            })
            .map_err(|e| Error::io("transport thread", e))?;

        Ok((
            Engine {
                commands,
                thread: Some(thread),
                encrypted,
                started: false,
            },
            opened,
            event_rx,
        ))
    }

    fn send(&self, command: Command) -> Result<(), Error> {
        self.commands.send(command).map_err(|_| Error::Closed)
    }

    /// Starts media from `source` once the transport is connected. Once per engine.
    pub fn start(&mut self, source: Box<dyn Source>) -> Result<(), Error> {
        if self.started {
            return Err(Error::InvalidState("already started"));
        }
        self.send(Command::Start(source))?;
        self.started = true;
        Ok(())
    }

    /// Replaces the frame key. The kid and the counter carry on.
    pub fn set_key(&self, format: u8, epoch: u8, key: [u8; KEY_LEN]) -> Result<(), Error> {
        if !self.encrypted {
            return Err(Error::InvalidState("opened without E2EE, there is no key to replace"));
        }
        self.send(Command::SetKey(params::format(format)?, epoch, key))
    }

    /// Caps the target bitrate and what the estimator probes for.
    pub fn set_max_bitrate(&self, bps: u64) -> Result<(), Error> {
        params::check_bitrate(bps)?;
        self.send(Command::SetMaxBitrate(bps))
    }

    /// Test hook: drops the next `count` media packets on their way to the socket.
    pub fn drop_media_packets(&self, count: u64) -> Result<(), Error> {
        self.send(Command::DropMedia(count))
    }

    /// Hands every frame sent from the next key frame on to `tap` in the clear, before
    /// encryption, or stops that with `None` (smooth P2, P3). Turning it on, again too, asks the
    /// source for a key frame.
    pub fn set_stream_preview(&self, tap: Option<PreviewTap>) -> Result<(), Error> {
        self.send(Command::StreamPreview(tap))
    }

    /// Stops the engine and waits for its threads.
    pub fn close(&mut self) {
        let _ = self.commands.send(Command::Close);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.close();
    }
}

/// The control loop of a real encoder: follow the estimate, stay under the cap.
fn target(estimate: u64, max: u64) -> u64 {
    (estimate.saturating_mul(9) / 10).min(max)
}

/// Everything the transport thread owns.
struct Transport {
    rtc: Rtc,
    socket: UdpSocket,
    local: SocketAddr,
    wire: Wire,
    ssrc: Ssrc,
    seq: u64,
    rtp_clock: RtpClock,
    /// The Dependency Descriptor's frame number: frames sent so far, wrapping (AV1, Q6).
    frame_number: u16,
    encryption: Option<(Encryptor, pylon_e2ee::Source)>,
    commands: Receiver<Command>,
    events: Sender<Event>,
    control: Arc<SourceControl>,
    pending_source: Option<Box<dyn Source>>,
    source_thread: Option<JoinHandle<()>>,
    frames: Option<Receiver<EncodedFrame>>,
    source_dropped: Arc<AtomicU64>,
    opened_at: Instant,
    connected: bool,
    next_stats: Instant,
    drop_media: u64,
    start: u64,
    max: u64,
    estimate: Option<u64>,
    stats: Stats,
    /// The send queue as last sampled, and the highest since the last statistics.
    queue: QueueSample,
    queue_max: QueueSample,
    encrypt_errors_logged: Vec<pylon_e2ee::FrameError>,
    /// When a frame was last handed to str0m, and the times between since the last statistics
    /// (smooth A1.3).
    last_send: Option<Instant>,
    send_intervals: Vec<f64>,
    /// The sharer's preview as the share itself, while it is on (smooth P2).
    stream_preview: Option<StreamPreview>,
    /// The rate to sustain with padding, as handed to str0m (smooth U2).
    sustain: Sustain,
}

/// One reading of str0m's send queue.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct QueueSample {
    packets: u64,
    bytes: u64,
    /// `bytes` in milliseconds of the target bitrate.
    ms: u64,
}

impl QueueSample {
    fn max(self, other: QueueSample) -> QueueSample {
        QueueSample {
            packets: self.packets.max(other.packets),
            bytes: self.bytes.max(other.bytes),
            ms: self.ms.max(other.ms),
        }
    }
}

/// The source's next frame if one waits. A source whose end of the channel is gone has ended
/// (it returned or its thread panicked), and the engine has nothing left to send.
fn next_frame(frames: Option<&Receiver<EncodedFrame>>) -> Result<Option<EncodedFrame>, String> {
    match frames.map(Receiver::try_recv) {
        None | Some(Err(TryRecvError::Empty)) => Ok(None),
        Some(Ok(frame)) => Ok(Some(frame)),
        Some(Err(TryRecvError::Disconnected)) => Err("source: ended".into()),
    }
}

/// How long `bytes` take at `bps`, in milliseconds.
fn queue_ms(bytes: u64, bps: u64) -> u64 {
    if bps == 0 {
        return 0;
    }
    bytes.saturating_mul(8000) / bps
}

/// Median and largest of `values`.
fn median_max(values: &mut [f64]) -> (Option<f64>, Option<f64>) {
    if values.is_empty() {
        return (None, None);
    }
    values.sort_by(f64::total_cmp);
    let round = |v: f64| (v * 1000.0).round() / 1000.0;
    (Some(round(values[values.len() / 2])), Some(round(values[values.len() - 1])))
}

/// Median, 95th percentile (nearest rank) and largest of `intervals`, `None` with fewer than
/// two (smooth A1.4).
fn interval_summary(intervals: &mut [f64]) -> Option<(f64, f64, f64)> {
    let n = intervals.len();
    if n < 2 {
        return None;
    }
    intervals.sort_by(f64::total_cmp);
    let round = |v: f64| (v * 1000.0).round() / 1000.0;
    let p95 = intervals[(n * 95).div_ceil(100) - 1];
    Some((round(intervals[n / 2]), round(p95), round(intervals[n - 1])))
}

impl Transport {
    fn run(mut self) {
        let reason = match self.run_loop() {
            Ok(reason) => reason,
            Err(message) => {
                tracing::error!(%message, "engine stopped");
                self.emit(Event::Error { message, fatal: true });
                CloseReason::Error
            }
        };
        self.control.stop();
        self.frames = None;
        if let Some(thread) = self.source_thread.take() {
            let _ = thread.join();
        }
        tracing::info!(?reason, frames = self.stats.frames_sent, "engine closed");
        self.emit(Event::Closed(reason));
    }

    fn emit(&self, event: Event) {
        let _ = self.events.send(event);
    }

    fn ms_since_open(&self) -> u64 {
        self.opened_at.elapsed().as_millis() as u64
    }

    fn run_loop(&mut self) -> Result<CloseReason, String> {
        let mut buffer = vec![0u8; 2000];
        loop {
            loop {
                match self.commands.try_recv() {
                    Ok(Command::Close) | Err(TryRecvError::Disconnected) => return Ok(CloseReason::Requested),
                    Ok(command) => self.command(command),
                    Err(TryRecvError::Empty) => break,
                }
            }
            if self.connected && self.pending_source.is_some() {
                self.start_source()?;
            }

            let timeout = loop {
                match self.rtc.poll_output().map_err(|e| format!("poll_output: {e}"))? {
                    Output::Timeout(at) => break at,
                    Output::Transmit(transmit) => self.transmit(transmit),
                    Output::Event(event) => self.rtc_event(event),
                }
            };

            if !self.rtc.is_alive() {
                return Ok(CloseReason::Disconnected);
            }
            if let Some(failure) = self.control.failure() {
                return Err(format!("source: {failure}"));
            }
            self.sample_queue();
            self.follow_sustain();

            let now = Instant::now();
            if self.connected && now >= self.next_stats {
                self.emit_stats();
                self.next_stats = (self.next_stats + STATS_INTERVAL).max(now);
            }

            // A source that failed just before it ended says why.
            let frame = next_frame(self.frames.as_ref())
                .map_err(|ended| self.control.failure().map_or(ended, |failure| format!("source: {failure}")))?;
            if let Some(frame) = frame {
                self.send_frame(frame)?;
                continue;
            }

            if timeout <= now {
                self.rtc
                    .handle_input(Input::Timeout(now))
                    .map_err(|e| format!("handle_input timeout: {e}"))?;
                continue;
            }

            // The socket is non-blocking and the wait is a sleep, because a socket read timeout
            // is rounded up to a kernel tick. With a tick of 1 ms the pacer fell behind and a
            // queue of over a second built up inside str0m (parent plan 7.1).
            match self.socket.recv_from(&mut buffer) {
                Ok((len, source)) => {
                    // Something that is not STUN, DTLS, RTP or RTCP is not worth stopping for.
                    if let Ok(receive) = Receive::new(Protocol::Udp, source, self.local, &buffer[..len]) {
                        self.rtc
                            .handle_input(Input::Receive(Instant::now(), receive))
                            .map_err(|e| format!("handle_input receive: {e}"))?;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    let wait = timeout.saturating_duration_since(now);
                    crate::wait::until(&self.socket, now + wait.min(MAX_SLEEP));
                }
                // An ICMP error from an earlier send. The node may come back, ICE decides. Windows
                // reports a port unreachable as `ConnectionReset` (WSAECONNRESET).
                Err(e) if matches!(e.kind(), std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::ConnectionReset) => {}
                Err(e) => return Err(format!("socket: {e}")),
            }
        }
    }

    fn command(&mut self, command: Command) {
        match command {
            Command::Start(source) => self.pending_source = Some(source),
            Command::SetKey(format, epoch, key) => {
                if let Some((encryptor, _)) = &mut self.encryption {
                    encryptor.set_key(format, epoch, &key);
                    tracing::info!(epoch, "frame key replaced");
                }
            }
            Command::SetMaxBitrate(bps) => {
                self.max = bps;
                self.control.set_max_bitrate(bps);
                self.rtc.bwe().set_bitrate(minimum(self.sustain.asked, bps), Bitrate::bps(bps));
                self.update_target();
                tracing::info!(bps, "max bitrate");
            }
            Command::DropMedia(count) => self.drop_media = self.drop_media.saturating_add(count),
            // Each time it is turned on it waits for a key frame and asks for one (smooth P3).
            Command::StreamPreview(tap) => {
                self.stream_preview = tap.map(|tap| StreamPreview::on(tap, &self.control));
                tracing::info!(on = self.stream_preview.is_some(), "stream preview");
            }
            Command::Close => {}
        }
    }

    fn start_source(&mut self) -> Result<(), String> {
        let Some(mut source) = self.pending_source.take() else {
            return Ok(());
        };
        let (sink, frames, dropped) = frame_channel(FRAME_QUEUE);
        self.frames = Some(frames);
        self.source_dropped = dropped;
        let control = self.control.clone();
        let thread = std::thread::Builder::new()
            .name("pylon-media source".into())
            .spawn(move || {
                let _priority = crate::priority::media_thread();
                source.run(sink, &control)
            })
            .map_err(|e| format!("source thread: {e}"))?;
        self.source_thread = Some(thread);
        tracing::info!("source started");
        Ok(())
    }

    /// Hands a changed sustain rate to str0m, keeping the desired rate (smooth U2).
    fn follow_sustain(&mut self) {
        if let Some(minimum) = self.sustain.changed(self.control.sustain_bitrate(), self.max) {
            self.rtc.bwe().set_bitrate(minimum, Bitrate::bps(self.max));
            // At debug: the pipeline hands a change on only when it matters (fix E8).
            tracing::debug!(bps = minimum.as_u64(), "sustain bitrate");
        }
    }

    fn update_target(&mut self) {
        let estimate = self.estimate.unwrap_or(self.start);
        self.control.set_target_bitrate(target(estimate, self.max));
    }

    fn transmit(&mut self, transmit: Transmit) {
        let data: &[u8] = &transmit.contents;
        // SRTP leaves the RTP header readable. RTCP packet types land in 192..=223.
        if data.len() >= 12 && (128..192).contains(&data[0]) && !(192..=223).contains(&data[1]) {
            let pt = data[1] & 0x7f;
            if pt == self.wire.pt {
                if self.drop_media > 0 {
                    self.drop_media -= 1;
                    return;
                }
                self.stats.media_packets_sent += 1;
                self.stats.media_bytes_sent += data.len() as u64;
            } else if pt == self.wire.rtx_pt {
                self.stats.rtx_packets_sent += 1;
                self.stats.rtx_bytes_sent += data.len() as u64;
            }
        }
        let _ = self.socket.send_to(data, transmit.destination);
    }

    fn rtc_event(&mut self, event: RtcEvent) {
        match event {
            RtcEvent::Connected => {
                self.connected = true;
                self.next_stats = Instant::now() + STATS_INTERVAL;
                let version = self.rtc.direct_api().dtls_protocol_version();
                self.stats.dtls_version = version.map(|v| format!("{v:?}"));
                tracing::info!(ms = self.ms_since_open(), dtls = ?self.stats.dtls_version, "connected");
                self.emit(Event::Connected);
            }
            RtcEvent::IceConnectionStateChange(state) => {
                let state = match state {
                    IceConnectionState::New => IceState::New,
                    IceConnectionState::Checking => IceState::Checking,
                    IceConnectionState::Connected => IceState::Connected,
                    IceConnectionState::Completed => IceState::Completed,
                    IceConnectionState::Disconnected => IceState::Disconnected,
                };
                tracing::info!(?state, ms = self.ms_since_open(), "ice");
                self.emit(Event::IceState(state));
            }
            RtcEvent::EgressBitrateEstimate(BweKind::Twcc { estimate, .. }) => {
                self.estimate = Some(estimate.as_u64());
                self.update_target();
            }
            RtcEvent::KeyframeRequest(request) => {
                self.control.want_key_frame();
                let kind = match request.kind {
                    KeyframeRequestKind::Pli => KeyFrameKind::Pli,
                    KeyframeRequestKind::Fir => KeyFrameKind::Fir,
                };
                tracing::debug!(?kind, "key frame request");
                self.emit(Event::KeyFrameRequest(kind));
            }
            RtcEvent::MediaEgressStats(stats) => {
                self.stats.nacks = stats.nacks;
                self.stats.plis = stats.plis;
                self.stats.firs = stats.firs;
                if let Some(loss) = stats.loss {
                    self.stats.loss_fraction = Some(loss);
                }
                if let Some(rtt) = stats.rtt {
                    self.stats.rtt_ms = Some(rtt.as_secs_f64() * 1000.0);
                }
            }
            RtcEvent::PeerStats(stats) => {
                if let Some(rtt) = stats.rtt {
                    self.stats.rtt_ms = Some(rtt.as_secs_f64() * 1000.0);
                }
                if let Some(loss) = stats.egress_loss_fraction {
                    self.stats.loss_fraction = Some(loss);
                }
            }
            _ => {}
        }
    }

    /// Reads str0m's send queue (it refreshes its snapshot on every poll), for the source's
    /// backlog rule and the statistics.
    fn sample_queue(&mut self) {
        let reading = self
            .rtc
            .direct_api()
            .stream_tx(&self.ssrc)
            .and_then(|stream| stream.queue_info().map(|q| (q.packet_count() as u64, q.byte_size() as u64)));
        let (packets, bytes) = reading.unwrap_or((0, 0));
        self.queue = QueueSample {
            packets,
            bytes,
            ms: queue_ms(bytes, self.control.target_bitrate()),
        };
        self.queue_max = self.queue_max.max(self.queue);
        self.control.set_queued_bytes(bytes);
    }

    fn emit_stats(&mut self) {
        let report = self.control.take_report();
        let mut encode_ms = report.encode_ms;
        let (encode_ms_median, encode_ms_max) = median_max(&mut encode_ms);
        let mut stats = self.stats.clone();
        stats.ms_since_open = self.ms_since_open();
        stats.frames_dropped_source = self.source_dropped.load(Ordering::Relaxed);
        stats.queued_packets = self.queue.packets;
        stats.queued_packets_max = self.queue_max.packets;
        stats.queued_bytes = self.queue.bytes;
        stats.queued_bytes_max = self.queue_max.bytes;
        stats.queued_ms_max = self.queue_max.ms;
        stats.bandwidth_estimate_bps = self.estimate;
        stats.target_bitrate_bps = self.control.target_bitrate();
        stats.sustain_bitrate_bps = minimum(self.sustain.asked, self.max).as_u64();
        stats.frames_skipped_backlog = report.frames_skipped_backlog;
        stats.frames_skipped_rate = report.frames_skipped_rate;
        stats.frame_rate_divisor = report.frame_rate_divisor;
        stats.encoded_width = report.encoded_size.map(|(width, _)| width);
        stats.encoded_height = report.encoded_size.map(|(_, height)| height);
        stats.size_steps_down = report.size_steps_down;
        stats.size_steps_up = report.size_steps_up;
        stats.encoder_bitrate_bps = report.encoder_bitrate_bps;
        stats.encoder_output_bps = report.encoder_output_bps;
        stats.encode_ms_median = encode_ms_median;
        stats.encode_ms_max = encode_ms_max;
        stats.key_frames_forced = report.key_frames_forced;
        stats.key_frames_repeated = report.key_frames_repeated;
        if let Some(capture) = &report.capture {
            let mut delays = report.capture_delay_ms.clone();
            let (median, max) = median_max(&mut delays);
            stats.capture_frames_delivered = Some(capture.frames_delivered);
            stats.capture_frames_taken = Some(capture.frames_taken);
            stats.capture_frames_dropped_rate = Some(capture.frames_dropped_rate);
            stats.capture_buffer_path = Some(capture.buffer_path);
            stats.capture_delay_ms_median = median;
            stats.capture_delay_ms_max = max;
            stats.capture_frames_untimed = Some(capture.frames_untimed);
        }
        let mut intervals = report.frame_interval_ms;
        let frame = interval_summary(&mut intervals);
        stats.frame_interval_ms_median = frame.map(|(median, _, _)| median);
        stats.frame_interval_ms_p95 = frame.map(|(_, p95, _)| p95);
        stats.frame_interval_ms_max = frame.map(|(_, _, max)| max);
        stats.frame_gaps_long = report.frame_gaps_long;
        let send = interval_summary(&mut self.send_intervals);
        stats.send_interval_ms_p95 = send.map(|(_, p95, _)| p95);
        stats.send_interval_ms_max = send.map(|(_, _, max)| max);
        self.send_intervals.clear();
        self.queue_max = self.queue;
        self.emit(Event::Stats(stats));
    }

    /// Hands a frame to the stream preview (smooth P2, P3).
    fn preview_frame(&mut self, data: Vec<u8>, key: bool, capture_time: Instant) {
        let Some(preview) = &mut self.stream_preview else {
            return;
        };
        let t_ms = capture_time.saturating_duration_since(self.opened_at).as_secs_f64() * 1000.0;
        let frame = PreviewFrame { codec: self.wire.codec, key, t_ms: (t_ms * 1000.0).round() / 1000.0, data };
        preview.hand(frame, &self.control, Instant::now());
    }

    fn send_frame(&mut self, frame: EncodedFrame) -> Result<(), String> {
        let codec = match self.wire.codec {
            VideoCodec::H264 => Codec::H264,
            VideoCodec::Av1 => Codec::Av1,
        };
        let sealed = match &mut self.encryption {
            None => None,
            Some((encryptor, source)) => match encryptor.encrypt(codec, source, &frame.data) {
                Ok(sealed) => Some(sealed),
                Err(error) => {
                    // Dropped, never sent in the clear. The frames after it refer to it, so a
                    // key frame is asked for.
                    self.stats.frames_dropped_encryption += 1;
                    self.control.want_key_frame();
                    if !self.encrypt_errors_logged.contains(&error) {
                        self.encrypt_errors_logged.push(error);
                        tracing::warn!(%error, "frame dropped, encryption failed");
                    }
                    return Ok(());
                }
            },
        };
        // The sharer's preview gets the frame in the clear as it goes to the packetizer (smooth
        // P2): the plaintext itself when it was encrypted, a copy when it is sent plain.
        let wanted = self.stream_preview.as_ref().is_some_and(|preview| preview.wants(frame.key));
        let data = match sealed {
            Some(sealed) => {
                if wanted {
                    self.preview_frame(frame.data, frame.key, frame.capture_time);
                }
                sealed
            }
            None => {
                if wanted {
                    self.preview_frame(frame.data.clone(), frame.key, frame.capture_time);
                }
                frame.data
            }
        };
        let payloads = match self.wire.codec {
            VideoCodec::H264 => h264::packetize(&data, PAYLOAD_LIMIT),
            VideoCodec::Av1 => match av1::packetize(&data, frame.key, PAYLOAD_LIMIT) {
                Ok(payloads) => payloads,
                Err(error) => {
                    tracing::warn!(%error, bytes = data.len(), "frame that is not OBUs dropped");
                    Vec::new()
                }
            },
        };
        if payloads.is_empty() {
            match self.wire.codec {
                VideoCodec::H264 => tracing::warn!(bytes = data.len(), "frame without NAL units dropped"),
                VideoCodec::Av1 => tracing::warn!(bytes = data.len(), "frame without OBUs to send dropped"),
            }
            // The frames after it refer to it, as after an encryption failure (fix E11).
            self.control.want_key_frame();
            return Ok(());
        }
        let rtp_time = self.rtp_clock.at(frame.capture_time);
        // str0m is never handed a wallclock in the future: a sender report made before it would
        // carry RTP time 0 (fix E4). The RTP timestamp keeps the capture time.
        let wallclock = frame.capture_time.min(Instant::now());
        let pt = self.wire.pt.into();
        let last = payloads.len() - 1;
        // AV1: a Dependency Descriptor on every packet (Q6).
        let descriptors = match self.wire.codec {
            VideoCodec::H264 => Vec::new(),
            VideoCodec::Av1 => DependencyDescriptor::for_frame(frame.key, self.frame_number, payloads.len()),
        };

        let mut api = self.rtc.direct_api();
        let stream = api.stream_tx(&self.ssrc).ok_or("the declared stream is gone")?;
        for (index, payload) in payloads.into_iter().enumerate() {
            let mut write = RtpWrite::new(pt, SeqNo::from(self.seq), rtp_time, wallclock, payload)
                .marker(index == last)
                .nackable(true);
            if let Some(descriptor) = descriptors.get(index) {
                let mut ext_vals = ExtensionValues::default();
                ext_vals.user_values.set(DependencyDescriptorBytes(descriptor.to_bytes()));
                write = write.ext_vals(ext_vals);
            }
            stream.write_rtp(write);
            self.seq += 1;
        }
        self.frame_number = self.frame_number.wrapping_add(1);
        let now = Instant::now();
        if let Some(last) = self.last_send.replace(now) {
            self.send_intervals.push(now.saturating_duration_since(last).as_secs_f64() * 1000.0);
        }
        self.stats.frames_sent += 1;
        self.stats.key_frames_sent += u64::from(frame.key);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{E2eeParams, SourceBinding, VideoParams};
    use serde_json::{Value, json};

    fn params() -> OpenParams {
        OpenParams {
            router_rtp_capabilities: serde_json::from_str(include_str!("../testdata/router_rtp_capabilities.json")).unwrap(),
            transport: serde_json::from_str(include_str!("../testdata/transport.json")).unwrap(),
            e2ee: None,
            video: VideoParams { start_bitrate: 1_500_000, max_bitrate: 8_000_000, codec: VideoCodec::H264 },
        }
    }

    #[test]
    fn open_with_av1() {
        let mut av1 = params();
        av1.video.codec = VideoCodec::Av1;
        // The H264-only router has no AV1.
        assert!(Engine::open(av1.clone()).is_err());
        av1.router_rtp_capabilities = serde_json::from_str(include_str!("../testdata/router_rtp_capabilities_av1.json")).unwrap();
        let (mut engine, opened, events) = Engine::open(av1).unwrap();
        let rtp = &opened.rtp_parameters;
        assert_eq!(rtp["codecs"][0]["mimeType"], "video/AV1");
        assert_eq!(rtp["codecs"][1]["parameters"]["apt"], rtp["codecs"][0]["payloadType"]);
        assert!(rtp["headerExtensions"].as_array().unwrap().iter().any(|e| e["uri"] == DEPENDENCY_DESCRIPTOR_URI && e["id"] == 7));
        engine.close();
        assert_eq!(events.iter().last(), Some(Event::Closed(CloseReason::Requested)));
    }

    #[test]
    fn the_descriptor_serializer_writes_what_it_is_given() {
        let serializer = DependencyDescriptorSerializer;
        let mut ev = ExtensionValues::default();
        let mut buf = [0u8; 32];
        // Nothing given, nothing written: str0m leaves the extension out.
        assert_eq!(serializer.write_to(&mut buf, &ev), 0);
        let bytes = DependencyDescriptor { start_of_frame: true, end_of_frame: true, key: true, frame_number: 9, structure: true }.to_bytes();
        ev.user_values.set(DependencyDescriptorBytes(bytes.clone()));
        assert_eq!(serializer.write_to(&mut buf, &ev), 9);
        assert_eq!(&buf[..9], &bytes[..]);
        assert!(!serializer.requires_two_byte_form(&ev));
        assert!(serializer.is_video() && !serializer.is_audio());
        assert_eq!(serializer.write_to(&mut buf[..4], &ev), 0);
    }

    #[test]
    fn open_signals_what_it_sends() {
        let (mut engine, opened, events) = Engine::open(params()).unwrap();
        assert_eq!(opened.dtls_parameters["role"], "client");
        assert_eq!(opened.dtls_parameters["fingerprints"][0]["algorithm"], "sha-256");
        let encoding = &opened.rtp_parameters["encodings"][0];
        let (ssrc, rtx) = (encoding["ssrc"].as_u64().unwrap(), encoding["rtx"]["ssrc"].as_u64().unwrap());
        assert!(ssrc != 0 && rtx != 0 && ssrc != rtx);
        assert_eq!(opened.rtp_parameters["rtcp"]["cname"].as_str().unwrap().len(), 20);
        assert!(engine.set_key(1, 1, [0; KEY_LEN]).is_err());
        assert!(engine.set_max_bitrate(0).is_err());
        engine.close();
        let last = events.iter().last();
        assert_eq!(last, Some(Event::Closed(CloseReason::Requested)));
        assert_eq!(engine.set_max_bitrate(1), Err(Error::Closed));
    }

    #[test]
    fn bad_parameters_are_errors() {
        let mut no_h264 = params();
        no_h264.router_rtp_capabilities = json!({ "codecs": [] });
        assert!(Engine::open(no_h264).is_err());

        let mut bad_transport = params();
        bad_transport.transport["ice_candidates"] = Value::Null;
        assert!(Engine::open(bad_transport).is_err());

        let mut zero = params();
        zero.video.max_bitrate = 0;
        assert!(Engine::open(zero).is_err());

        let e2ee = E2eeParams {
            format: 1,
            epoch: 0,
            key: [7; KEY_LEN],
            kid: 1,
            counter: 0,
            source: SourceBinding { tag: 3, stream_key: None },
        };
        let mut bad_binding = params();
        bad_binding.e2ee = Some(e2ee.clone());
        assert!(Engine::open(bad_binding).is_err());

        let mut bad_format = params();
        bad_format.e2ee = Some(E2eeParams { format: 9, source: SourceBinding { tag: 2, stream_key: None }, ..e2ee.clone() });
        assert!(Engine::open(bad_format).is_err());

        let mut good = params();
        good.e2ee = Some(E2eeParams { source: SourceBinding { tag: 2, stream_key: None }, ..e2ee });
        let (engine, _, _) = Engine::open(good).unwrap();
        assert!(engine.set_key(1, 1, [8; KEY_LEN]).is_ok());
        assert!(engine.set_key(2, 1, [8; KEY_LEN]).is_err());
    }

    #[test]
    fn numbers_follow_the_rules() {
        for _ in 0..1000 {
            let n = Numbers::pick().unwrap();
            assert!(n.ssrc != 0 && n.rtx_ssrc != 0 && n.ssrc != n.rtx_ssrc);
            assert!((1..=32767).contains(&n.seq));
        }
    }

    #[test]
    fn interval_summaries() {
        // Fewer than two: none.
        assert_eq!(interval_summary(&mut []), None);
        assert_eq!(interval_summary(&mut [16.7]), None);
        // 1 to 20 in any order: median the 11th, p95 the 19th by nearest rank, max 20.
        let mut list: Vec<f64> = (1..=20).rev().map(f64::from).collect();
        assert_eq!(interval_summary(&mut list), Some((11.0, 19.0, 20.0)));
        // 59 steady frames and one stall: the median and p95 stay, the max shows it.
        let mut list = vec![16.6667; 59];
        list.push(100.0);
        assert_eq!(interval_summary(&mut list), Some((16.667, 16.667, 100.0)));
        // Alternating 17 and 33 ms: the p95 shows what the mean of 25 hides.
        let mut list: Vec<f64> = (0..60).map(|n| if n % 2 == 0 { 17.0 } else { 33.0 }).collect();
        assert_eq!(interval_summary(&mut list), Some((33.0, 33.0, 33.0)));
        let mut two = [40.0, 10.0];
        assert_eq!(interval_summary(&mut two), Some((40.0, 40.0, 40.0)));
    }

    #[test]
    fn the_stream_preview_waits_for_a_key_frame_and_a_drop_asks_for_one() {
        use std::sync::{Mutex, atomic::AtomicBool};
        let control = SourceControl::default();
        let handed = Arc::new(Mutex::new(Vec::new()));
        let takes = Arc::new(AtomicBool::new(true));
        let tap: PreviewTap = {
            let (handed, takes) = (handed.clone(), takes.clone());
            Box::new(move |frame: PreviewFrame| {
                if !takes.load(Ordering::Relaxed) {
                    return false;
                }
                handed.lock().unwrap().push((frame.key, frame.data));
                true
            })
        };
        let frame = |key, n| PreviewFrame { codec: VideoCodec::H264, key, t_ms: 0.0, data: vec![n] };
        let now = Instant::now();
        // Turned on: a key frame is asked for, and nothing goes before one.
        let mut preview = StreamPreview::on(tap, &control);
        assert!(control.take_key_frame_wanted());
        assert!(!preview.wants(false));
        assert!(preview.wants(true));
        preview.hand(frame(true, 1), &control, now);
        assert!(preview.wants(false));
        preview.hand(frame(false, 2), &control, now);
        assert!(!control.take_key_frame_wanted());
        // The host does not take one: dropped for the preview, a key frame asked for, and the
        // frames after it wait for that key frame.
        takes.store(false, Ordering::Relaxed);
        preview.hand(frame(false, 3), &control, now);
        assert!(control.take_key_frame_wanted());
        assert!(!preview.wants(false));
        takes.store(true, Ordering::Relaxed);
        assert!(preview.wants(true));
        preview.hand(frame(true, 4), &control, now);
        assert!(preview.wants(false));
        assert!(!control.take_key_frame_wanted());
        assert_eq!(*handed.lock().unwrap(), vec![(true, vec![1]), (false, vec![2]), (true, vec![4])]);
    }

    #[test]
    fn a_stream_preview_the_host_is_not_taking_asks_for_a_key_frame_at_most_every_5_s() {
        // Fix E6: the host's stdout stalls, every frame offered is refused.
        let control = SourceControl::default();
        let mut preview = StreamPreview::on(Box::new(|_| false), &control);
        // The ask on turning it on is at once.
        assert!(control.take_key_frame_wanted());
        let t = Instant::now();
        let ms = |v: u64| t + Duration::from_millis(v);
        let key = || PreviewFrame { codec: VideoCodec::H264, key: true, t_ms: 0.0, data: vec![1] };
        // The first refusal asks.
        preview.hand(key(), &control, ms(100));
        assert!(control.take_key_frame_wanted());
        // Each key frame refused in the next 5 s asks for nothing more: ten at 500 ms apart.
        for n in 1..10 {
            preview.hand(key(), &control, ms(100 + n * 500));
            assert!(!control.take_key_frame_wanted(), "at {} ms", 100 + n * 500);
        }
        // From 5 s after the last ask, one ask again, then quiet again.
        preview.hand(key(), &control, ms(5100));
        assert!(control.take_key_frame_wanted());
        preview.hand(key(), &control, ms(5600));
        assert!(!control.take_key_frame_wanted());
        // Turned on again: the ask is at once, whatever the time.
        let _preview = StreamPreview::on(Box::new(|_| false), &control);
        assert!(control.take_key_frame_wanted());
    }

    #[test]
    fn rtp_timestamps_never_go_back() {
        // Fix E1: the transport's own rule, behind the pipeline's.
        let t = Instant::now() + Duration::from_secs(10);
        let ms = |v: u64| t + Duration::from_millis(v);
        let mut clock = RtpClock::new(u32::MAX - 1000);
        assert_eq!(clock.at(t), u32::MAX - 1000);
        // 10 ms is 900 ticks, wrapping past u32::MAX.
        assert_eq!(clock.at(ms(10)), (u32::MAX - 1000).wrapping_add(900));
        // A capture time before the last, the same one, one before the first: one tick each.
        assert_eq!(clock.at(ms(4)), (u32::MAX - 1000).wrapping_add(901));
        assert_eq!(clock.at(ms(4)), (u32::MAX - 1000).wrapping_add(902));
        assert_eq!(clock.at(t - Duration::from_millis(5)), (u32::MAX - 1000).wrapping_add(903));
        // Later again: from the capture time as before.
        assert_eq!(clock.at(ms(20)), (u32::MAX - 1000).wrapping_add(1800));
    }

    #[test]
    fn the_sustain_rate_reaches_str0m_once_per_change_and_never_over_the_maximum() {
        // U2, U4: nothing asked, nothing handed over (the open set the zero minimum).
        let mut sustain = Sustain::default();
        assert_eq!(sustain.changed(0, 8_000_000), None);
        // A change is handed over once.
        assert_eq!(sustain.changed(2_073_600, 8_000_000), Some(Bitrate::bps(2_073_600)));
        assert_eq!(sustain.changed(2_073_600, 8_000_000), None);
        // Never over the share's maximum (U1).
        assert_eq!(sustain.changed(4_665_600, 3_000_000), Some(Bitrate::bps(3_000_000)));
        assert_eq!(minimum(4_665_600, 3_000_000), Bitrate::bps(3_000_000));
        // Back on the top rung: zero again, once.
        assert_eq!(sustain.changed(0, 8_000_000), Some(Bitrate::ZERO));
        assert_eq!(sustain.changed(0, 8_000_000), None);
        assert_eq!(minimum(0, 8_000_000), MIN_BITRATE);
    }

    #[test]
    fn targets() {
        assert_eq!(target(10_000_000, 8_000_000), 8_000_000);
        assert_eq!(target(1_500_000, 8_000_000), 1_350_000);
        assert_eq!(target(u64::MAX, 8_000_000), 8_000_000);
    }

    #[test]
    fn a_source_gone_from_its_channel_has_ended() {
        assert!(matches!(next_frame(None), Ok(None)));
        let (sink, frames, _) = frame_channel(2);
        assert!(matches!(next_frame(Some(&frames)), Ok(None)));
        sink.push(EncodedFrame { data: vec![1], key: true, capture_time: Instant::now() }).unwrap();
        // A source thread that panicked drops its sink like one that returned.
        let source = std::thread::spawn(move || {
            let _sink = sink;
            panic!("a source that panics");
        });
        assert!(source.join().is_err());
        assert_eq!(next_frame(Some(&frames)).map(|f| f.map(|f| f.data)), Ok(Some(vec![1])));
        assert_eq!(next_frame(Some(&frames)).map(|f| f.is_some()), Err("source: ended".into()));
    }

    #[test]
    fn bitrates_above_the_ceiling_are_refused() {
        let mut huge = params();
        huge.video.start_bitrate = u64::MAX;
        assert!(Engine::open(huge).is_err());
        let (mut engine, _, events) = Engine::open(params()).unwrap();
        assert!(engine.set_max_bitrate(u64::MAX).is_err());
        assert!(engine.set_max_bitrate(params::MAX_BITRATE).is_ok());
        assert!(engine.drop_media_packets(u64::MAX).is_ok());
        assert!(engine.drop_media_packets(u64::MAX).is_ok());
        // The transport thread took all of that without a panic.
        engine.close();
        assert_eq!(events.iter().last(), Some(Event::Closed(CloseReason::Requested)));
    }
}
