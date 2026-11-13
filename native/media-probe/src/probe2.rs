// Probe 2: the sending half (.plans/native-media-engine-probe2.md, and
// .plans/native-media-engine-m2-engine.md D21). The `pylon-media-host` sidecar sends H264 from a
// file, encrypted with kid 1 unless the variant is `plain`, to the node. The node gives a viewer a
// receive transport and a consumer. With PROBE_CODEC=AV1 the sidecar sends AV1 instead: from an
// IVF file (`--ivf`) or the pattern through the encoder (AV1 step 2, Q11).
//
// Signalling with viewer/run.mjs is JSON lines on stdin and stdout (probe 2's D4). Everything for
// a human goes to stderr, the sidecar's log included.

use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use mediasoup::prelude::*;
use mediasoup::producer::{ProducerTraceEventData, ProducerTraceEventType};
use mediasoup::types::data_structures::{DtlsState, IceState};
use mediasoup::types::rtp_parameters::RtpCapabilities;
use serde_json::{Value, json};
use tokio::io::AsyncBufReadExt;

use crate::{
    env, node,
    sidecar::{Sidecar, SidecarLog},
};

// Probe 2's D5.
const STREAM_KEY: &str = "probe-stream";
const STREAM_TAG: u8 = 3;
const KID: u8 = 1;
const EPOCH: u8 = 0;
const FORMAT: u8 = 1;
// `pylon_e2ee::key::sender_key(b"media-probe static root", 1001)` in base64, the sender key of
// probe 2's D5. Worked out once with pylon-e2ee, which the probe no longer depends on.
const SENDER_KEY: &str = "1A/XDsQEv9natW8fWSIG8w==";

const FPS: u64 = 30;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Variant {
    Plain,
    Encrypted,
    WrongKey,
    /// The pattern through the hardware encoder, encrypted as `Encrypted` (M5a D18).
    Encoder,
    /// The screen, captured through the portal, encrypted as `Encrypted` (M5b T2).
    Screen,
}

impl Variant {
    fn parse(name: &str) -> Option<Self> {
        match name {
            "plain" => Some(Self::Plain),
            "encrypted" => Some(Self::Encrypted),
            "wrong-key" => Some(Self::WrongKey),
            "encoder" => Some(Self::Encoder),
            "screen" => Some(Self::Screen),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Plain => "plain",
            Self::Encrypted => "encrypted",
            Self::WrongKey => "wrong-key",
            Self::Encoder => "encoder",
            Self::Screen => "screen",
        }
    }
}

fn random_counter() -> u32 {
    let mut bytes = [0u8; 4];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut bytes))
        .expect("read /dev/urandom");
    u32::from_be_bytes(bytes) >> 1
}

fn send(message: Value) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{message}");
    let _ = out.flush();
}

fn usage() -> i32 {
    eprintln!("usage: media-probe viewer [--variant plain|encrypted|wrong-key|encoder|screen] (--h264 <file> | --ivf <file>)");
    2
}

pub async fn run(args: &[String]) -> i32 {
    let mut variant = Variant::Encrypted;
    let mut file = None;
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--variant" => match args.next().and_then(|v| Variant::parse(v)) {
                Some(v) => variant = v,
                None => return usage(),
            },
            // The file of the session's codec: Annex-B H264, or IVF with PROBE_CODEC=AV1.
            "--h264" | "--ivf" => file = args.next().cloned(),
            _ => return usage(),
        }
    }
    let Some(file) = file else {
        return usage();
    };
    let file = match std::fs::canonicalize(&file) {
        Ok(path) => path,
        Err(error) => {
            eprintln!("cannot read {file}: {error}");
            return 1;
        }
    };

    let max_bps: u64 = env::<u64>("MAX_MBPS", 8) * 1_000_000;
    let start_bps: u64 = env::<u64>("START_KBPS", 1500) * 1000;
    let began = Instant::now();
    let at = move || began.elapsed().as_secs_f64() * 1000.0;
    let codec = crate::sidecar::codec();
    eprintln!("variant {}, codec {codec}, file {}", variant.name(), file.display());

    let e2ee = if variant == Variant::Plain {
        Value::Null
    } else {
        let counter = random_counter();
        eprintln!("e2ee: kid {KID}, epoch {EPOCH}, counter starts at {counter}, stream key {STREAM_KEY}");
        json!({
            "format": FORMAT,
            "epoch": EPOCH,
            "key": SENDER_KEY,
            "kid": KID,
            "counter": counter,
            "source": { "tag": STREAM_TAG, "stream_key": STREAM_KEY },
        })
    };

    // The node, and the sidecar on its send transport, as in probe 1.
    let node = node::Node::start().await;
    let send_transport = node.send_transport().await;
    let capabilities = node.capabilities();
    let flags: &[&str] = if variant == Variant::Plain { &["--insecure-plain"] } else { &[] };
    let mut sidecar = match Sidecar::start(flags) {
        Ok(sidecar) => sidecar,
        Err(error) => {
            eprintln!("{error}");
            return 1;
        }
    };
    let source = match variant {
        Variant::Encoder => json!({ "pattern": { "width": 1920, "height": 1080, "fps": 60 } }),
        // The capture's maximum size and rate: SCREEN_MAX=<w>x<h>, SCREEN_FPS.
        Variant::Screen => {
            let max = std::env::var("SCREEN_MAX").unwrap_or_else(|_| "1920x1080".into());
            let (w, h) = max.split_once('x').and_then(|(w, h)| Some((w.parse::<u32>().ok()?, h.parse::<u32>().ok()?))).unwrap_or((1920, 1080));
            json!({ "screen": { "fps": env::<u32>("SCREEN_FPS", 60), "max_width": w, "max_height": h } })
        }
        _ => json!({ "file": { "path": file, "fps": FPS } }),
    };
    let open = json!({
        "router_rtp_capabilities": capabilities,
        "transport": node::transport_parameters(&send_transport),
        "e2ee": e2ee,
        "source": source,
        "video": video(start_bps, max_bps, &codec),
    });
    let opened = if variant == Variant::Screen {
        // The portal's dialog waits for a person, up to five minutes. With SCREEN_TARGET (the
        // capture's `target` as the protocol's JSON, a Windows sidecar: M7.5 C15) nobody is
        // asked, so it is not waited for.
        let token = std::env::var("RESTORE_TOKEN_FILE").ok().and_then(|p| std::fs::read_to_string(p).ok()).map(|t| t.trim().to_owned());
        let target = match std::env::var("SCREEN_TARGET") {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(target) => Some(target),
                Err(error) => {
                    eprintln!("SCREEN_TARGET is not JSON: {error}");
                    sidecar.close(Duration::from_secs(5)).await;
                    return 2;
                }
            },
            Err(_) => None,
        };
        let wait = Duration::from_secs(if target.is_some() { 15 } else { 300 });
        if let Some(target) = &target {
            eprintln!("capture target {target}");
        }
        // The capture's `max_fps`: SCREEN_FPS, or SCREEN_MAX_FPS when set (`none` leaves it out).
        let max_fps = match std::env::var("SCREEN_MAX_FPS").as_deref() {
            Ok("none") => None,
            Ok(fps) => fps.parse().ok(),
            Err(_) => Some(env::<u32>("SCREEN_FPS", 60)),
        };
        match sidecar.hello_and_capture(token.filter(|t| !t.is_empty()), max_fps, target, wait).await {
            Ok(ready) => {
                if let (Ok(path), Some(token)) = (std::env::var("RESTORE_TOKEN_FILE"), ready["restore_token"].as_str()) {
                    let _ = std::fs::write(path, token);
                }
                sidecar.open(open).await
            }
            Err(error) => Err(error),
        }
    } else {
        sidecar.hello_and_open(open).await
    };
    let opened = match opened {
        Ok(opened) => opened,
        Err(error) => {
            eprintln!("open: {error}");
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
    eprintln!("node: producer {}", producer.id());
    if let Err(error) = sidecar.send(json!({ "start": {} })).await {
        eprintln!("start: {error}");
        return 1;
    }
    // PROBE_PREVIEW asks for the sharer's preview from here (M6 preview step 3: the screen source
    // on Windows); the pictures go to PROBE_PREVIEW_OUT when set.
    let previewing = sidecar.start_preview_schedule();
    let log = sidecar.log.clone();

    let node_key_events = Arc::new(Mutex::new(Vec::<(f64, &'static str)>::new()));
    producer
        .enable_trace_event(vec![ProducerTraceEventType::KeyFrame, ProducerTraceEventType::Pli])
        .await
        .expect("trace events");
    {
        let node_key_events = node_key_events.clone();
        producer
            .on_trace(move |event| {
                let what = match event {
                    ProducerTraceEventData::KeyFrame { .. } => "key frame in",
                    ProducerTraceEventData::Pli { .. } => "PLI out",
                    _ => return,
                };
                node_key_events.lock().unwrap().push((at(), what));
            })
            .detach();
    }

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let connected = log.lock().unwrap().connected_ms.is_some()
            && send_transport.dtls_state() == DtlsState::Connected
            && matches!(send_transport.ice_state(), IceState::Connected | IceState::Completed);
        if connected {
            let log = log.lock().unwrap();
            eprintln!("engine connected at {:?} ms, opened at {:?} ms (sidecar clock)", log.connected_ms, log.opened_ms);
            break;
        }
        let fatal = log.lock().unwrap().fatal().cloned();
        if Instant::now() > deadline || fatal.is_some() {
            eprintln!("engine did not connect: {fatal:?}");
            sidecar.close(Duration::from_secs(5)).await;
            return 1;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    // The viewer's receive transport, made like the node's consumer transport.
    let recv_transport = node.recv_transport().await;
    recv_transport
        .on_ice_state_change(move |state| eprintln!("[node {:7.1} ms] viewer ice {state:?}", at()))
        .detach();
    recv_transport
        .on_dtls_state_change(move |state| eprintln!("[node {:7.1} ms] viewer dtls {state:?}", at()))
        .detach();
    send(json!({
        "routing": {
            "routerRtpCapabilities": capabilities,
            "transport": {
                "id": recv_transport.id(),
                "iceParameters": recv_transport.ice_parameters(),
                "iceCandidates": recv_transport.ice_candidates(),
                "dtlsParameters": recv_transport.dtls_parameters(),
            },
        },
    }));

    let mut consumer: Option<Consumer> = None;
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            line = lines.next_line() => {
                let line = match line {
                    Ok(Some(line)) => line,
                    Ok(None) => {
                        eprintln!("stdin closed");
                        break;
                    }
                    Err(error) => {
                        eprintln!("stdin: {error}");
                        break;
                    }
                };
                if line.trim().is_empty() {
                    continue;
                }
                let message: Value = match serde_json::from_str(&line) {
                    Ok(message) => message,
                    Err(error) => {
                        send(json!({ "error": format!("not JSON: {error}") }));
                        continue;
                    }
                };

                if let Some(connect) = message.get("connect") {
                    let result = match serde_json::from_value(connect["dtlsParameters"].clone()) {
                        Ok(dtls_parameters) => recv_transport
                            .connect(WebRtcTransportRemoteParameters { dtls_parameters })
                            .await
                            .map_err(|e| format!("connect: {e}")),
                        Err(e) => Err(format!("dtlsParameters: {e}")),
                    };
                    eprintln!("[node {:7.1} ms] viewer connect: {result:?}", at());
                    match result {
                        Ok(()) => send(json!({ "connected": true })),
                        Err(error) => send(json!({ "error": error })),
                    }
                } else if let Some(consume) = message.get("consume") {
                    let capabilities: Result<RtpCapabilities, _> =
                        serde_json::from_value(consume["rtpCapabilities"].clone());
                    let result = match capabilities {
                        Ok(capabilities) => {
                            // Paused, as the node creates sinks (transport.rs, create_sink).
                            let mut options = ConsumerOptions::new(producer.id(), capabilities);
                            options.paused = true;
                            recv_transport.consume(options).await.map_err(|e| format!("consume: {e}"))
                        }
                        Err(e) => Err(format!("rtpCapabilities: {e}")),
                    };
                    match result {
                        Ok(c) => {
                            eprintln!("[node {:7.1} ms] consumer {} created paused, type {:?}", at(), c.id(), c.r#type());
                            send(json!({
                                "consumer": {
                                    "id": c.id(),
                                    "producerId": producer.id(),
                                    "kind": c.kind(),
                                    "rtpParameters": c.rtp_parameters(),
                                },
                            }));
                            consumer = Some(c);
                        }
                        Err(error) => {
                            eprintln!("{error}");
                            send(json!({ "error": error }));
                        }
                    }
                } else if message.get("resume").is_some() {
                    match &consumer {
                        Some(c) => match c.resume().await {
                            Ok(()) => {
                                eprintln!("[node {:7.1} ms] consumer resumed", at());
                                send(json!({ "resumed": true }));
                            }
                            Err(e) => send(json!({ "error": format!("resume: {e}") })),
                        },
                        None => send(json!({ "error": "no consumer to resume" })),
                    }
                } else if message.get("stats").is_some() {
                    let stats = stats(&producer, consumer.as_ref(), &log, &node_key_events, at()).await;
                    send(json!({ "stats": stats }));
                } else if message.get("stop").is_some() {
                    eprintln!("stop");
                    break;
                } else {
                    send(json!({ "error": format!("unknown message {line}") }));
                }
            }
            _ = tick.tick() => {
                let stat = producer.get_stats().await.ok().and_then(|s| s.into_iter().next());
                let log = log.lock().unwrap();
                eprintln!(
                    "[{:7.1} ms] frames {} packets {} rtx {} queued {} estimate {:?} key requests {} | node packets {:?} score {:?} lost {:?}",
                    at(),
                    log.stat("frames_sent"),
                    log.stat("media_packets_sent"),
                    log.stat("rtx_packets_sent"),
                    log.stat("queued_packets"),
                    log.last_stats().and_then(|s| s["bandwidth_estimate_bps"].as_u64()),
                    log.key_frame_requests.len(),
                    stat.as_ref().map(|s| s.packet_count),
                    stat.as_ref().map(|s| s.score),
                    stat.as_ref().map(|s| s.packets_lost),
                );
                if let Some(error) = log.fatal() {
                    eprintln!("engine error: {error}");
                }
            }
        }
    }

    let final_stats = stats(&producer, consumer.as_ref(), &log, &node_key_events, at()).await;
    let code = sidecar.close(Duration::from_secs(5)).await;
    eprintln!("final: {final_stats}");
    eprintln!("sidecar exit status {code:?}, closed {:?}", log.lock().unwrap().closed);
    if previewing {
        let dir = std::env::var_os("PROBE_PREVIEW_OUT").map(std::path::PathBuf::from);
        let log = log.lock().unwrap();
        eprintln!("{}", crate::sidecar::write_previews(&log, dir.as_deref()));
        let preview_errors: Vec<_> = log.errors.iter().filter(|e| e["message"].as_str().is_some_and(|m| m.starts_with("preview"))).collect();
        eprintln!("preview errors: {preview_errors:?}");
    }
    0
}

/// The sidecar's view in the shape probe 2's driver reads (`engine.keyFrameRequests`).
fn engine_stats(log: &SidecarLog) -> Value {
    let last = log.last_stats().cloned().unwrap_or(Value::Null);
    let max_queued = log.stats.iter().filter_map(|s| s["queued_packets"].as_u64()).max();
    json!({
        "openedMs": log.opened_ms,
        "connectedMs": log.connected_ms,
        "dtls": last["dtls_version"],
        "framesSent": last["frames_sent"],
        "mediaPackets": last["media_packets_sent"],
        "rtxPackets": last["rtx_packets_sent"],
        "maxQueued": max_queued,
        "queued": last["queued_packets"],
        "keyFramesSent": last["key_frames_sent"],
        "framesDroppedSource": last["frames_dropped_source"],
        "framesDroppedEncryption": last["frames_dropped_encryption"],
        "keyFrameRequests": log.key_frame_requests.iter().map(|(ms, kind)| json!({ "atMs": ms, "kind": kind })).collect::<Vec<_>>(),
        "estimateBps": last["bandwidth_estimate_bps"],
        "errors": log.errors,
        "captureReady": log.capture_ready.as_ref().map(|r| json!({ "width": r["width"], "height": r["height"], "format": r["format"], "modifier": r["modifier"], "dmabuf": r["dmabuf"] })),
        "captureChanged": log.capture_changed,
        "last": last,
    })
}

async fn stats(
    producer: &Producer,
    consumer: Option<&Consumer>,
    log: &Mutex<SidecarLog>,
    node_key_events: &Mutex<Vec<(f64, &'static str)>>,
    at_ms: f64,
) -> Value {
    let producer_stats = producer.get_stats().await.ok();
    let consumer_stats = match consumer {
        Some(c) => c.get_stats().await.ok().map(|s| json!(s)),
        None => None,
    };
    let engine = engine_stats(&log.lock().unwrap());
    let events = node_key_events.lock().unwrap();
    json!({
        "atMs": at_ms,
        "producer": producer_stats,
        "producerScore": producer.score(),
        "consumer": consumer_stats,
        "consumerScore": consumer.map(|c| c.score()),
        "consumerPaused": consumer.map(|c| c.paused()),
        "engine": engine,
        "node": {
            "keyFramesIn": events.iter().filter(|e| e.1 == "key frame in").count(),
            "plisOut": events.iter().filter(|e| e.1 == "PLI out").map(|e| e.0).collect::<Vec<_>>(),
        },
    })
}

/// `open.video`: as before AV1 for H264, with `codec` for AV1.
fn video(start_bps: u64, max_bps: u64, codec: &str) -> Value {
    let mut video = json!({ "start_bitrate": start_bps, "max_bitrate": max_bps });
    if codec != "H264" {
        video["codec"] = json!(codec);
    }
    video
}
