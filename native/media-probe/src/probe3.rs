// Probe 3: sender, pacer and encoder against a limited link
// (.plans/native-media-engine-m5a-encoder.md, D15 to D17).
//
// The sidecar sends the screen test pattern (1920x1080 at 60, unencrypted, at most 8 Mbps) through the
// hardware encoder to the node, through a relay that limits the link toward the node. Six phases
// of 20 s: no limit, 3 Mbps, 1.5 Mbps, 6 Mbps, no limit, 3 Mbps with 2 % loss and 40 ms delay.
// In the middle of each phase the probe asks for a key frame through a consumer. One row is
// recorded per statistics event of the sidecar, and per phase the figures and floors of D17.
//
//   media-probe probe3 [--still] [--out <dir>]
//
// Env: PHASE_S (20), MAX_MBPS (8), START_KBPS (1500), PATTERN (1920x1080@60, others only to
// diagnose), KIND (screen, or stress to diagnose), PROBE_CODEC (H264, or AV1).

use std::{
    collections::BTreeMap,
    fmt::Write as _,
    io::Write as _,
    net::{SocketAddr, UdpSocket},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use mediasoup::prelude::*;
use mediasoup::producer::{ProducerTraceEventData, ProducerTraceEventType};
use mediasoup::types::data_structures::{DtlsState, IceState};
use mediasoup::types::rtp_parameters::RtpCapabilities;
use serde_json::{Value, json};

use crate::{
    env, node,
    relay::{Counters, Limits, Relay},
    sidecar::Sidecar,
};

/// The pattern of D16. PATTERN=<w>x<h>@<fps> overrides it for diagnostic runs only.
fn pattern() -> (u32, u32, u32) {
    let parsed = std::env::var("PATTERN").ok().and_then(|p| {
        let (size, fps) = p.split_once('@')?;
        let (w, h) = size.split_once('x')?;
        Some((w.parse().ok()?, h.parse().ok()?, fps.parse().ok()?))
    });
    parsed.unwrap_or((1920, 1080, 60))
}
/// The pattern changes its whole picture this often (D13).
const SCENE_CUT: Duration = Duration::from_secs(10);
/// Rows this close after a scene cut, a forced key frame or a phase change are not judged for
/// the queue (D17).
const SETTLE: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug)]
struct Phase {
    name: &'static str,
    limits: Limits,
}

fn phases() -> Vec<Phase> {
    let limit = |name, mbps: f64, loss: f64, delay_ms: u64| Phase {
        name,
        limits: Limits {
            rate_bps: (mbps > 0.0).then(|| (mbps * 1e6) as u64),
            delay: Duration::from_millis(delay_ms),
            loss,
        },
    };
    vec![
        limit("none", 0.0, 0.0, 0),
        limit("3M", 3.0, 0.0, 0),
        limit("1.5M", 1.5, 0.0, 0),
        limit("6M", 6.0, 0.0, 0),
        limit("none again", 0.0, 0.0, 0),
        limit("3M 2% loss 40ms", 3.0, 0.02, 40),
    ]
}

// ─── The far side of a consumer: frames as the node forwards them ──

#[derive(Clone, Copy, Debug)]
struct ReceivedFrame {
    /// When its last packet arrived, from the probe's start.
    at: Duration,
    bytes: u64,
    key: bool,
}

#[derive(Default)]
struct Frames {
    done: Vec<ReceivedFrame>,
    /// RTP timestamp of the frame being put together, its bytes and whether it is a key frame.
    current: Option<(u32, u64, bool)>,
    /// With a preview asked for and H264: the stream as the consumer gets it, in Annex-B, to
    /// compare the preview's pictures with (M6 preview step 1).
    stream: Option<Vec<u8>>,
}

/// Appends an H264 RTP payload to an Annex-B stream: a single NAL unit, a STAP-A's units, or a
/// FU-A's piece (the first with its NAL header put back).
fn depacketize_h264(payload: &[u8], stream: &mut Vec<u8>) {
    const START: [u8; 4] = [0, 0, 0, 1];
    let Some(&first) = payload.first() else {
        return;
    };
    match first & 0x1f {
        1..=23 => {
            stream.extend_from_slice(&START);
            stream.extend_from_slice(payload);
        }
        24 => {
            let mut at = 1;
            while at + 2 <= payload.len() {
                let len = u16::from_be_bytes([payload[at], payload[at + 1]]) as usize;
                let Some(unit) = payload.get(at + 2..at + 2 + len) else {
                    return;
                };
                stream.extend_from_slice(&START);
                stream.extend_from_slice(unit);
                at += 2 + len;
            }
        }
        28 if payload.len() > 2 => {
            if payload[1] & 0x80 != 0 {
                stream.extend_from_slice(&START);
                stream.push((first & 0xe0) | (payload[1] & 0x1f));
            }
            stream.extend_from_slice(&payload[2..]);
        }
        _ => {}
    }
}

/// The RTP payload of a packet, if it is one.
pub(crate) fn rtp_payload(packet: &[u8]) -> Option<(u8, bool, u32, &[u8])> {
    if packet.len() < 12 || packet[0] >> 6 != 2 || (192..=223).contains(&packet[1]) {
        return None;
    }
    let pt = packet[1] & 0x7f;
    let marker = packet[1] & 0x80 != 0;
    let timestamp = u32::from_be_bytes([packet[4], packet[5], packet[6], packet[7]]);
    let mut at = 12 + 4 * (packet[0] & 0x0f) as usize;
    if packet[0] & 0x10 != 0 {
        if packet.len() < at + 4 {
            return None;
        }
        let words = u16::from_be_bytes([packet[at + 2], packet[at + 3]]) as usize;
        at += 4 + 4 * words;
    }
    let mut end = packet.len();
    if packet[0] & 0x20 != 0 {
        end = end.checked_sub(*packet.last()? as usize)?;
    }
    (at <= end).then(|| (pt, marker, timestamp, &packet[at..end]))
}

/// True if an H264 RTP payload carries an IDR slice or an SPS.
fn payload_is_key(payload: &[u8]) -> bool {
    let Some(&first) = payload.first() else {
        return false;
    };
    match first & 0x1f {
        5 | 7 => true,
        24 => {
            let mut at = 1;
            while at + 2 < payload.len() {
                let len = u16::from_be_bytes([payload[at], payload[at + 1]]) as usize;
                if matches!(payload[at + 2] & 0x1f, 5 | 7) {
                    return true;
                }
                at += 2 + len;
            }
            false
        }
        28 => payload.len() > 1 && payload[1] & 0x80 != 0 && payload[1] & 0x1f == 5,
        _ => false,
    }
}

/// True if an AV1 RTP payload starts a coded video sequence: N in its aggregation header (the AV1
/// RTP payload format, section 4.4), which the engine sets on the first packet of a key frame.
fn payload_is_key_av1(payload: &[u8]) -> bool {
    payload.first().is_some_and(|header| header & 0x08 != 0)
}

fn run_receiver(socket: UdpSocket, media_pt: u8, av1: bool, began: Instant, frames: Arc<Mutex<Frames>>, stop: Arc<AtomicBool>) {
    socket.set_read_timeout(Some(Duration::from_millis(20))).unwrap();
    let mut buffer = [0u8; 2048];
    while !stop.load(Ordering::Relaxed) {
        let Ok((len, _)) = socket.recv_from(&mut buffer) else {
            continue;
        };
        let Some((pt, marker, timestamp, payload)) = rtp_payload(&buffer[..len]) else {
            continue;
        };
        if pt != media_pt {
            continue;
        }
        let mut frames = frames.lock().unwrap();
        if let Some(stream) = &mut frames.stream {
            depacketize_h264(payload, stream);
        }
        let key = if av1 { payload_is_key_av1(payload) } else { payload_is_key(payload) };
        let at = began.elapsed();
        match &mut frames.current {
            Some((ts, bytes, k)) if *ts == timestamp => {
                *bytes += payload.len() as u64;
                *k |= key;
            }
            _ => {
                // A frame whose marker never came is closed by the next one.
                if let Some((_, bytes, key)) = frames.current.take() {
                    frames.done.push(ReceivedFrame { at, bytes, key });
                }
                frames.current = Some((timestamp, payload.len() as u64, key));
            }
        }
        if marker && let Some((_, bytes, key)) = frames.current.take() {
            frames.done.push(ReceivedFrame { at, bytes, key });
        }
    }
}

// ─── Rows ────────────────────────────────────────────────────────

/// One statistics event of the sidecar with what the relay and the node said at that moment.
#[derive(Clone, Debug)]
struct Row {
    /// From the probe's start.
    t: Duration,
    phase: usize,
    stats: Value,
    relay: Counters,
    node_bytes: u64,
    node_bitrate: u64,
}

const COLUMNS: &str = "t_s,phase,limit_bps,estimate_bps,target_bps,encoder_bps,encoder_output_bps,sent_bps,media_sent_bps,node_received_bps,node_bitrate_bps,queued_packets,queued_packets_max,queued_bytes,queued_bytes_max,queued_ms_max,frames_sent,frames_skipped,frames_skipped_rate,frame_rate_divisor,key_frames_sent,key_frames_forced,encode_ms_median,encode_ms_max,relay_queued_ms_max,relay_dropped_over_limit,relay_dropped_loss,relay_in_packets,rtt_ms,loss_fraction";

fn delta(rows: &[Row], i: usize, f: impl Fn(&Row) -> u64) -> u64 {
    if i == 0 { f(&rows[0]) } else { f(&rows[i]).saturating_sub(f(&rows[i - 1])) }
}

/// Seconds between this row and the previous.
fn span(rows: &[Row], i: usize) -> f64 {
    if i == 0 { 1.0 } else { (rows[i].t - rows[i - 1].t).as_secs_f64().max(0.001) }
}

fn rate(rows: &[Row], i: usize, f: impl Fn(&Row) -> u64) -> u64 {
    (delta(rows, i, f) as f64 * 8.0 / span(rows, i)) as u64
}

fn stat(row: &Row, name: &str) -> u64 {
    row.stats[name].as_u64().unwrap_or(0)
}

fn sent_bps(rows: &[Row], i: usize) -> u64 {
    rate(rows, i, |r| r.relay.in_bytes)
}

fn csv(rows: &[Row], phases: &[Phase]) -> String {
    let mut out = String::from(COLUMNS);
    out.push('\n');
    for i in 0..rows.len() {
        let r = &rows[i];
        let s = &r.stats;
        let opt = |v: &Value| if v.is_null() { String::new() } else { v.to_string() };
        let _ = writeln!(
            out,
            "{:.3},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{:.1},{},{},{},{},{}",
            r.t.as_secs_f64(),
            phases[r.phase].name,
            phases[r.phase].limits.rate_bps.map(|v| v.to_string()).unwrap_or_default(),
            opt(&s["bandwidth_estimate_bps"]),
            stat(r, "target_bitrate_bps"),
            opt(&s["encoder_bitrate_bps"]),
            opt(&s["encoder_output_bps"]),
            sent_bps(rows, i),
            rate(rows, i, |r| stat(r, "media_bytes_sent")),
            rate(rows, i, |r| r.node_bytes),
            r.node_bitrate,
            stat(r, "queued_packets"),
            stat(r, "queued_packets_max"),
            stat(r, "queued_bytes"),
            stat(r, "queued_bytes_max"),
            stat(r, "queued_ms_max"),
            delta(rows, i, |r| stat(r, "frames_sent")),
            delta(rows, i, |r| stat(r, "frames_skipped_backlog")),
            delta(rows, i, |r| stat(r, "frames_skipped_rate")),
            opt(&s["frame_rate_divisor"]),
            delta(rows, i, |r| stat(r, "key_frames_sent")),
            delta(rows, i, |r| stat(r, "key_frames_forced")),
            opt(&s["encode_ms_median"]),
            opt(&s["encode_ms_max"]),
            r.relay.queued_ms_max,
            delta(rows, i, |r| r.relay.dropped_over_limit),
            delta(rows, i, |r| r.relay.dropped_loss),
            delta(rows, i, |r| r.relay.in_packets),
            opt(&s["rtt_ms"]),
            opt(&s["loss_fraction"]),
        );
    }
    out
}

// ─── The run ─────────────────────────────────────────────────────

fn usage() -> i32 {
    eprintln!("usage: media-probe probe3 [--still] [--out <dir>]");
    2
}

fn check(lines: &mut Vec<String>, results: &mut Vec<bool>, name: &str, pass: bool, detail: String) {
    let line = format!("{} {name}: {detail}", if pass { "PASS" } else { "FAIL" });
    println!("{line}");
    lines.push(line);
    results.push(pass);
}

pub async fn run(args: &[String]) -> i32 {
    let mut still = false;
    let mut out: Option<PathBuf> = None;
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--still" => still = true,
            "--out" => out = args.next().map(PathBuf::from),
            _ => return usage(),
        }
    }
    let out = out.unwrap_or_else(|| PathBuf::from(format!("probe3-runs/{}", if still { "still" } else { "cuts" })));
    std::fs::create_dir_all(&out).expect("output directory");
    let phase_len = Duration::from_secs(env("PHASE_S", 20));
    let max_bps: u64 = env::<u64>("MAX_MBPS", 8) * 1_000_000;
    let start_bps: u64 = env::<u64>("START_KBPS", 1500) * 1000;
    let phases = phases();
    let (width, height, fps) = pattern();
    let began = Instant::now();
    let unix_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    eprintln!("probe start unix_ms {unix_ms}");
    println!(
        "probe 3: {width}x{height} at {fps}, {} mode, {} phases of {:?}, output in {}",
        if still { "still" } else { "scene cut" },
        phases.len(),
        phase_len,
        out.display()
    );

    let node = node::Node::start().await;
    let send_transport = node.send_transport().await;
    let capabilities = node.capabilities();
    let mut transport_parameters = node::transport_parameters(&send_transport);

    // The relay takes the place of the node's UDP candidate.
    let candidate = transport_parameters["ice_candidates"]
        .as_array_mut()
        .and_then(|c| c.iter_mut().find(|c| c["protocol"] == "udp"))
        .expect("a UDP candidate");
    let node_address: SocketAddr = format!("{}:{}", candidate["address"].as_str().unwrap(), candidate["port"]).parse().unwrap();
    let mut relay = Relay::start(node_address).expect("relay");
    candidate["address"] = json!(relay.address.ip().to_string());
    candidate["port"] = json!(relay.address.port());
    println!("relay {} -> node {node_address}", relay.address);

    let mut sidecar = match Sidecar::start(&["--insecure-plain"]) {
        Ok(sidecar) => sidecar,
        Err(error) => {
            println!("FAIL sidecar: {error}");
            return 1;
        }
    };
    // PROBE_CODEC=AV1 sends AV1 through the encoder (AV1 step 2). H264 as before.
    let codec = crate::sidecar::codec();
    let mut video = json!({ "start_bitrate": start_bps, "max_bitrate": max_bps });
    if codec != "H264" {
        video["codec"] = json!(codec);
    }
    println!("codec {codec}");
    let opened = sidecar
        .hello_and_open(json!({
            "router_rtp_capabilities": capabilities,
            "transport": transport_parameters,
            "e2ee": null,
            "source": { "pattern": { "width": width, "height": height, "fps": fps, "still": still, "kind": std::env::var("KIND").unwrap_or_else(|_| "screen".into()) } },
            "video": video,
        }))
        .await;
    let opened = match opened {
        Ok(opened) => opened,
        Err(error) => {
            println!("FAIL open: {error}");
            sidecar.close(Duration::from_secs(5)).await;
            return 1;
        }
    };
    send_transport
        .connect(WebRtcTransportRemoteParameters {
            dtls_parameters: serde_json::from_value(opened["dtls_parameters"].clone()).expect("dtls parameters"),
        })
        .await
        .expect("connect send transport");
    let producer = node::produce(&send_transport, opened["rtp_parameters"].clone()).await;
    let key_frames_at_node = Arc::new(Mutex::new(Vec::<Duration>::new()));
    producer
        .enable_trace_event(vec![ProducerTraceEventType::KeyFrame])
        .await
        .expect("trace events");
    {
        let key_frames_at_node = key_frames_at_node.clone();
        producer
            .on_trace(move |event| {
                if let ProducerTraceEventData::KeyFrame { .. } = event {
                    key_frames_at_node.lock().unwrap().push(began.elapsed());
                }
            })
            .detach();
    }
    // PROBE_PREVIEW asks for the sharer's preview after `open` (M6 preview step 1, R8).
    let previewing = sidecar.start_preview_schedule();
    sidecar.send(json!({ "start": {} })).await.expect("start");
    let log = sidecar.log.clone();

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let connected = log.lock().unwrap().connected_ms.is_some()
            && send_transport.dtls_state() == DtlsState::Connected
            && matches!(send_transport.ice_state(), IceState::Connected | IceState::Completed);
        if connected {
            break;
        }
        let fatal = log.lock().unwrap().fatal().cloned();
        if Instant::now() > deadline || fatal.is_some() {
            println!("FAIL engine did not connect through the relay: {fatal:?}");
            sidecar.close(Duration::from_secs(5)).await;
            return 1;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    // A consumer to ask for key frames with and to see frames as the node forwards them.
    let recv_socket = UdpSocket::bind("127.0.0.1:0").expect("bind receiver");
    let recv_transport = node.plain_recv_transport(recv_socket.local_addr().unwrap().port()).await;
    let consumer_capabilities: RtpCapabilities = serde_json::from_value(capabilities.clone()).unwrap();
    let consumer = recv_transport
        .consume(ConsumerOptions::new(producer.id(), consumer_capabilities))
        .await
        .expect("consumer");
    let media_pt = consumer.rtp_parameters().codecs[0].payload_type();
    let av1 = codec == "AV1";
    let frames = Arc::new(Mutex::new(Frames { stream: (previewing && !av1).then(Vec::new), ..Frames::default() }));
    let stop_receiver = Arc::new(AtomicBool::new(false));
    let receiver = {
        let (frames, stop) = (frames.clone(), stop_receiver.clone());
        std::thread::spawn(move || run_receiver(recv_socket, media_pt, av1, began, frames, stop))
    };

    // The phases.
    let run_start = began.elapsed();
    let mut phase_starts = Vec::new();
    let mut requests: Vec<(usize, Duration)> = Vec::new();
    let mut rows: Vec<Row> = Vec::new();
    let mut seen_stats = log.lock().unwrap().stats.len();
    for (index, phase) in phases.iter().enumerate() {
        relay.set_limits(phase.limits);
        let start = began.elapsed();
        phase_starts.push(start);
        println!("[{:7.1} s] phase {index} {}", start.as_secs_f64(), phase.name);
        let mut asked = false;
        while began.elapsed() < start + phase_len {
            if !asked && began.elapsed() >= start + phase_len / 2 {
                let _ = consumer.request_key_frame().await;
                requests.push((index, began.elapsed()));
                asked = true;
            }
            let new: Vec<Value> = {
                let log = log.lock().unwrap();
                if let Some(error) = log.fatal() {
                    println!("engine error: {error}");
                }
                log.stats[seen_stats..].to_vec()
            };
            for stats in new {
                seen_stats += 1;
                let relay_now = relay.sample();
                let node_stat = producer.get_stats().await.ok().and_then(|s| s.into_iter().next());
                let row = Row {
                    t: began.elapsed(),
                    phase: index,
                    stats,
                    relay: relay_now,
                    node_bytes: node_stat.as_ref().map_or(0, |s| s.byte_count),
                    node_bitrate: node_stat.as_ref().map_or(0, |s| s.bitrate as u64),
                };
                rows.push(row);
                let i = rows.len() - 1;
                let r = &rows[i];
                println!(
                    "  {:6.1} s  est {:>9}  target {:>8}  enc {:>8}  out {:>8}  sent {:>8}  queue {:>3} ms (max)  skipped {:>3}  N {}  relay drops {:>3}",
                    r.t.as_secs_f64(),
                    r.stats["bandwidth_estimate_bps"].as_u64().unwrap_or(0),
                    stat(r, "target_bitrate_bps"),
                    r.stats["encoder_bitrate_bps"].as_u64().unwrap_or(0),
                    r.stats["encoder_output_bps"].as_u64().unwrap_or(0),
                    sent_bps(&rows, i),
                    stat(r, "queued_ms_max"),
                    delta(&rows, i, |r| stat(r, "frames_skipped_backlog")),
                    r.stats["frame_rate_divisor"].as_u64().unwrap_or(0),
                    delta(&rows, i, |r| r.relay.dropped_over_limit),
                );
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    let run_end = began.elapsed();
    tokio::time::sleep(Duration::from_millis(500)).await;
    stop_receiver.store(true, Ordering::Relaxed);
    let _ = receiver.join();
    let final_stats = log.lock().unwrap().last_stats().cloned().unwrap_or_default();
    let errors = log.lock().unwrap().errors.clone();
    let code = sidecar.close(Duration::from_secs(5)).await;
    relay.stop();

    // ─── Figures and floors ──────────────────────────────────────
    let frames_stream = frames.lock().unwrap().stream.take();
    let frames = std::mem::take(&mut frames.lock().unwrap().done);
    let node_keys = key_frames_at_node.lock().unwrap().clone();
    let phase_of = |t: Duration| phase_starts.iter().rposition(|s| *s <= t).unwrap_or(0);
    let pattern_start = frames.first().map(|f| f.at).unwrap_or(run_start);
    let mut lines = Vec::new();
    let mut results = Vec::new();
    let mut summary = String::new();
    let _ = writeln!(summary, "probe 3, pattern {width}x{height} at {fps}, {} mode, {} rows, phases of {:?}", if still { "still" } else { "scene cut" }, rows.len(), phase_len);
    let _ = writeln!(summary, "sent rate = UDP payload bytes from the sidecar toward the node per second, counted by the relay before loss and the limit");

    // Windows not judged for the queue: after scene cuts, forced key frames and phase changes.
    let mut settle: Vec<Duration> = phase_starts.clone();
    settle.extend(requests.iter().map(|(_, t)| *t));
    if !still {
        let mut cut = pattern_start + SCENE_CUT;
        while cut < run_end {
            settle.push(cut);
            cut += SCENE_CUT;
        }
    }
    let settled = |from: Duration, to: Duration| !settle.iter().any(|s| *s < to && from < *s + SETTLE);

    let mut queue_ok = true;
    let mut queue_worst = (0u64, Duration::ZERO);
    for i in 1..rows.len() {
        let (from, to) = (rows[i - 1].t, rows[i].t);
        let ms = stat(&rows[i], "queued_ms_max");
        if settled(from, to) && ms >= 500 {
            queue_ok = false;
        }
        if settled(from, to) && ms > queue_worst.0 {
            queue_worst = (ms, to);
        }
    }

    let mut sent_ok = true;
    let mut drops_ok = true;
    let mut key_ok = true;
    let mut recovered_ok = true;
    for (index, phase) in phases.iter().enumerate() {
        let start = phase_starts[index];
        let end = phase_starts.get(index + 1).copied().unwrap_or(run_end);
        let in_phase: Vec<usize> = (1..rows.len()).filter(|&i| rows[i].phase == index).collect();
        let _ = writeln!(summary, "\nphase {index} {} ({:.1} s to {:.1} s)", phase.name, start.as_secs_f64(), end.as_secs_f64());

        if let Some(limit) = phase.limits.rate_bps {
            // Time until the sent rate is within the limit.
            let within = in_phase.iter().find(|&&i| sent_bps(&rows, i) <= limit).map(|&i| rows[i].t - start);
            let _ = writeln!(summary, "  sent rate within the limit after {:?}", within.map(|d| format!("{:.1} s", d.as_secs_f64())));
            // From 8 s on: at least half the limit, relay drops under 1 %.
            let late: Vec<usize> = in_phase.iter().copied().filter(|&i| rows[i - 1].t >= start + Duration::from_secs(8)).collect();
            let rates: Vec<u64> = late.iter().map(|&i| sent_bps(&rows, i)).collect();
            let lowest = rates.iter().copied().min().unwrap_or(0);
            let mean = rates.iter().sum::<u64>() / rates.len().max(1) as u64;
            let packets: u64 = late.iter().map(|&i| delta(&rows, i, |r| r.relay.in_packets)).sum();
            let dropped: u64 = late.iter().map(|&i| delta(&rows, i, |r| r.relay.dropped_over_limit)).sum();
            let share = dropped as f64 / packets.max(1) as f64;
            let _ = writeln!(
                summary,
                "  from 8 s: sent rate lowest {lowest} mean {mean} bps against a limit of {limit} ({:.2} of it at the lowest), relay drops over the limit {dropped} of {packets} packets ({:.2} %)",
                lowest as f64 / limit as f64,
                share * 100.0
            );
            // D24: this floor does not apply in still mode.
            sent_ok &= still || (!rates.is_empty() && lowest * 2 >= limit);
            drops_ok &= share < 0.01;
        } else if index > 0 && phases[index - 1].limits.rate_bps.is_some() {
            let back = in_phase.iter().find(|&&i| sent_bps(&rows, i) > 5_000_000).map(|&i| rows[i].t - start);
            let _ = writeln!(summary, "  sent rate above 5 Mbps after {:?}", back.map(|d| format!("{:.1} s", d.as_secs_f64())));
            recovered_ok &= back.is_some_and(|d| d <= Duration::from_secs(10));
        }

        for (_, asked) in requests.iter().filter(|(p, _)| *p == index) {
            // The node's trace marks the first packet of a key frame. Judged is the whole frame,
            // its last packet at the far side of the consumer.
            let first_packet = node_keys.iter().find(|t| *t >= asked).map(|t| *t - *asked);
            let whole = frames.iter().find(|f| f.key && f.at >= *asked).map(|f| (f.at - *asked, f.bytes));
            let ms = |d: Duration| format!("{:.0} ms", d.as_secs_f64() * 1000.0);
            let _ = writeln!(
                summary,
                "  key frame asked at {:.2} s: first packet at the node after {:?}, whole frame ({:?} B) at the far side after {:?}",
                asked.as_secs_f64(),
                first_packet.map(ms),
                whole.map(|w| w.1),
                whole.map(|w| ms(w.0)),
            );
            key_ok &= whole.is_some_and(|(d, _)| d <= Duration::from_secs(1));
        }

        let phase_frames: Vec<&ReceivedFrame> = frames.iter().filter(|f| phase_of(f.at) == index).collect();
        if !phase_frames.is_empty() {
            let total: u64 = phase_frames.iter().map(|f| f.bytes).sum();
            let average = total as f64 / phase_frames.len() as f64;
            let largest = phase_frames.iter().map(|f| f.bytes).max().unwrap_or(0);
            let keys: Vec<String> = phase_frames
                .iter()
                .filter(|f| f.key)
                .map(|f| format!("{} B at {:.2} s", f.bytes, f.at.as_secs_f64()))
                .collect();
            let _ = writeln!(
                summary,
                "  frames at the far side {}, average {average:.0} B, largest {largest} B ({:.1} times the average), key frames: {}",
                phase_frames.len(),
                largest as f64 / average.max(1.0),
                if keys.is_empty() { "none".into() } else { keys.join(", ") }
            );
        }
        let skipped: u64 = in_phase.iter().map(|&i| delta(&rows, i, |r| stat(r, "frames_skipped_backlog"))).sum();
        let sent: u64 = in_phase.iter().map(|&i| delta(&rows, i, |r| stat(r, "frames_sent"))).sum();
        let rate_skipped: u64 = in_phase.iter().map(|&i| delta(&rows, i, |r| stat(r, "frames_skipped_rate"))).sum();
        let divisors: Vec<u64> = in_phase.iter().filter_map(|&i| rows[i].stats["frame_rate_divisor"].as_u64()).collect();
        let _ = writeln!(
            summary,
            "  frames sent {sent}, skipped for backlog {skipped}, skipped by the frame rate divisor {rate_skipped}, divisor N from {:?} to {:?}",
            divisors.iter().min(),
            divisors.iter().max()
        );
    }

    let key_frames_sent = final_stats["key_frames_sent"].as_u64().unwrap_or(0);
    let key_frames_forced = final_stats["key_frames_forced"].as_u64().unwrap_or(0);
    let unasked = key_frames_sent.saturating_sub(key_frames_forced + 1);
    let far_keys = frames.iter().filter(|f| f.key).count();
    let _ = writeln!(summary, "\nkey frames: sent {key_frames_sent}, forced on request {key_frames_forced}, first 1, so unasked {unasked}. At the far side {far_keys}, at the node {}.", node_keys.len());
    let _ = writeln!(summary, "sidecar exit {code:?}, errors {errors:?}");
    if previewing {
        let log = log.lock().unwrap();
        let _ = writeln!(summary, "{}", crate::sidecar::write_previews(&log, Some(&out.join("preview"))));
        if let Some(stream) = &frames_stream {
            let path = out.join("stream.h264");
            let _ = std::fs::write(&path, stream);
            let _ = writeln!(summary, "the consumer's stream: {} bytes in {}", stream.len(), path.display());
        }
    }
    print!("\n{summary}\n");

    check(
        &mut lines,
        &mut results,
        "D17.1a sent rate at least half the limit from 8 s",
        sent_ok,
        if still { "not applied in still mode (D24)".into() } else { "see the phases above".into() },
    );
    check(&mut lines, &mut results, "D17.1b relay drops under 1 % from 8 s", drops_ok, "see the phases above".into());
    check(
        &mut lines,
        &mut results,
        "D17.2 queue under 500 ms outside the 2 s after cuts, key frames and phase changes",
        queue_ok,
        format!("highest judged {} ms at {:.1} s", queue_worst.0, queue_worst.1.as_secs_f64()),
    );
    check(&mut lines, &mut results, "D17.3 forced key frame at the node within 1 s in every phase", key_ok, format!("{} requests", requests.len()));
    check(&mut lines, &mut results, "D17.4 back above 5 Mbps within 10 s of lifting the limit", recovered_ok, "see phase 4".into());
    check(&mut lines, &mut results, "D17.5 no unasked key frame", unasked == 0, format!("{unasked} unasked"));
    summary.push('\n');
    for line in &lines {
        summary.push_str(line);
        summary.push('\n');
    }

    let mut frame_csv = String::from("t_s,bytes,key\n");
    for f in &frames {
        let _ = writeln!(frame_csv, "{:.3},{},{}", f.at.as_secs_f64(), f.bytes, u8::from(f.key));
    }
    let write = |name: &str, text: &str| {
        let path = out.join(name);
        std::fs::File::create(&path).and_then(|mut f| f.write_all(text.as_bytes())).expect("write");
        println!("wrote {}", path.display());
    };
    write("seconds.csv", &csv(&rows, &phases));
    write("frames.csv", &frame_csv);
    write("summary.txt", &summary);
    let mut phase_map = BTreeMap::new();
    for (i, p) in phases.iter().enumerate() {
        phase_map.insert(i, json!({ "name": p.name, "start_s": phase_starts[i].as_secs_f64(), "limits": format!("{:?}", p.limits) }));
    }
    write("phases.json", &serde_json::to_string_pretty(&json!({ "phases": phase_map, "requests_s": requests.iter().map(|(p, t)| json!([p, t.as_secs_f64()])).collect::<Vec<_>>(), "node_key_frames_s": node_keys.iter().map(|t| t.as_secs_f64()).collect::<Vec<_>>(), "final_stats": final_stats })).unwrap());

    let failed = results.iter().filter(|p| !**p).count();
    println!("\n{} of {} floors passed", results.len() - failed, results.len());
    if failed == 0 { 0 } else { 1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_payloads() {
        assert!(payload_is_key(&[0x65, 1]));
        assert!(!payload_is_key(&[0x41, 1]));
        // STAP-A with an SPS.
        assert!(payload_is_key(&[0x78, 0, 2, 0x67, 1, 0, 2, 0x68, 1]));
        assert!(!payload_is_key(&[0x78, 0, 2, 0x06, 1]));
        // FU-A start of an IDR, and its middle.
        assert!(payload_is_key(&[0x7c, 0x85, 1]));
        assert!(!payload_is_key(&[0x7c, 0x05, 1]));
        // AV1: N set (W 3), and a packet without it.
        assert!(payload_is_key_av1(&[0x38, 1]));
        assert!(!payload_is_key_av1(&[0x20, 1]));
        assert!(!payload_is_key_av1(&[]));
    }

    #[test]
    fn h264_payloads_back_to_annex_b() {
        let mut stream = Vec::new();
        depacketize_h264(&[0x78, 0, 2, 0x67, 1, 0, 1, 0x68], &mut stream);
        depacketize_h264(&[0x7c, 0x85, 1, 2], &mut stream);
        depacketize_h264(&[0x7c, 0x45, 3], &mut stream);
        depacketize_h264(&[0x41, 9], &mut stream);
        assert_eq!(stream, vec![0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 0, 0, 0, 1, 0x65, 1, 2, 3, 0, 0, 0, 1, 0x41, 9]);
    }

    #[test]
    fn rtp_header() {
        let mut packet = vec![0x80, 0x80 | 102, 0, 1, 0, 0, 0, 9, 0, 0, 0, 1];
        packet.extend_from_slice(&[0x65, 7]);
        assert_eq!(rtp_payload(&packet), Some((102, true, 9, &[0x65, 7][..])));
        // With a one-word extension.
        let mut packet = vec![0x90, 102, 0, 1, 0, 0, 0, 9, 0, 0, 0, 1, 0xbe, 0xde, 0, 1, 1, 2, 3, 4];
        packet.extend_from_slice(&[0x41]);
        assert_eq!(rtp_payload(&packet), Some((102, false, 9, &[0x41][..])));
    }
}
