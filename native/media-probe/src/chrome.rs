// The Chromium baseline for probe 3 (.plans/native-media-engine-m5a-encoder.md, D26): Chromium,
// through mediasoup-client in the viewer harness, is the sender on the same node, behind the same
// relay, through the same phases. It shows what a mature estimator does on this rig.
//
//   media-probe chrome [--out <dir>]     driven by viewer/sender.mjs over stdin and stdout
//
// Signalling (JSON lines): this sends `routing`, then gets `connect` and `produce`, answers
// `connected` and `produced`. The driver then sends the page's `stats` once a second, and this
// sends `done` after the last phase. Everything for a human goes to stderr.
//
// Env: PHASE_S (20).

use std::{
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
use mediasoup::types::rtp_parameters::{MediaKind as MsMediaKind, RtpCapabilities, RtpParameters};
use serde_json::{Value, json};
use tokio::io::AsyncBufReadExt;

use crate::{
    env, node,
    probe3::rtp_payload,
    relay::{Limits, Relay},
};

fn send(message: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{message}");
    let _ = out.flush();
}

/// True if a VP8 RTP payload starts a key frame.
fn vp8_key(payload: &[u8]) -> bool {
    let Some(&first) = payload.first() else {
        return false;
    };
    let (start, pid) = (first & 0x10 != 0, first & 0x07);
    if !start || pid != 0 {
        return false;
    }
    let mut at = 1;
    if first & 0x80 != 0 {
        let Some(&x) = payload.get(1) else {
            return false;
        };
        at = 2;
        if x & 0x80 != 0 {
            at += if payload.get(at).is_some_and(|b| b & 0x80 != 0) { 2 } else { 1 };
        }
        if x & 0x40 != 0 {
            at += 1;
        }
        if x & 0x30 != 0 {
            at += 1;
        }
    }
    payload.get(at).is_some_and(|b| b & 0x01 == 0)
}

fn phases() -> Vec<(&'static str, Limits)> {
    let limit = |mbps: f64, loss: f64, delay_ms: u64| Limits {
        rate_bps: (mbps > 0.0).then(|| (mbps * 1e6) as u64),
        delay: Duration::from_millis(delay_ms),
        loss,
    };
    vec![
        ("none", limit(0.0, 0.0, 0)),
        ("3M", limit(3.0, 0.0, 0)),
        ("1.5M", limit(1.5, 0.0, 0)),
        ("6M", limit(6.0, 0.0, 0)),
        ("none again", limit(0.0, 0.0, 0)),
        ("3M 2% loss 40ms", limit(3.0, 0.02, 40)),
    ]
}

pub async fn run(args: &[String]) -> i32 {
    let mut out = PathBuf::from("probe3-runs/chrome");
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--out" => out = args.next().map(PathBuf::from).unwrap_or(out),
            _ => {
                eprintln!("usage: media-probe chrome [--out <dir>]");
                return 2;
            }
        }
    }
    std::fs::create_dir_all(&out).expect("output directory");
    let phase_len = Duration::from_secs(env("PHASE_S", 20));
    let phases = phases();
    let began = Instant::now();

    let node = node::Node::start_with(true).await;
    let send_transport = node.send_transport().await;
    let capabilities = node.capabilities();
    let mut candidates = serde_json::to_value(send_transport.ice_candidates()).unwrap();
    let candidate = candidates
        .as_array_mut()
        .and_then(|c| c.iter_mut().find(|c| c["protocol"] == "udp"))
        .expect("a UDP candidate");
    let node_address: SocketAddr = format!("{}:{}", candidate["address"].as_str().unwrap(), candidate["port"]).parse().unwrap();
    let mut relay = Relay::start(node_address).expect("relay");
    candidate["address"] = json!(relay.address.ip().to_string());
    candidate["port"] = json!(relay.address.port());
    eprintln!("relay {} -> node {node_address}", relay.address);
    send(json!({
        "routing": {
            "routerRtpCapabilities": capabilities,
            "transport": {
                "id": send_transport.id(),
                "iceParameters": send_transport.ice_parameters(),
                "iceCandidates": candidates,
                "dtlsParameters": send_transport.dtls_parameters(),
            },
        },
    }));

    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut producer: Option<Producer> = None;
    while producer.is_none() {
        let Ok(Some(line)) = lines.next_line().await else {
            eprintln!("stdin closed before produce");
            return 1;
        };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(connect) = message.get("connect") {
            let result = match serde_json::from_value(connect["dtlsParameters"].clone()) {
                Ok(dtls_parameters) => send_transport
                    .connect(WebRtcTransportRemoteParameters { dtls_parameters })
                    .await
                    .map_err(|e| e.to_string()),
                Err(e) => Err(e.to_string()),
            };
            match result {
                Ok(()) => send(json!({ "connected": true })),
                Err(error) => send(json!({ "error": error })),
            }
        } else if let Some(produce) = message.get("produce") {
            let parameters: Result<RtpParameters, _> = serde_json::from_value(produce["rtpParameters"].clone());
            match parameters {
                Ok(parameters) => {
                    let mut options = ProducerOptions::new(MsMediaKind::Video, parameters);
                    options.key_frame_request_delay = 1_000;
                    match send_transport.produce(options).await {
                        Ok(p) => {
                            send(json!({ "produced": { "id": p.id() } }));
                            producer = Some(p);
                        }
                        Err(e) => send(json!({ "error": e.to_string() })),
                    }
                }
                Err(e) => send(json!({ "error": e.to_string() })),
            }
        }
    }
    let producer = producer.unwrap();
    let key_frames_at_node = Arc::new(Mutex::new(Vec::<Duration>::new()));
    producer.enable_trace_event(vec![ProducerTraceEventType::KeyFrame]).await.expect("trace");
    {
        let keys = key_frames_at_node.clone();
        producer
            .on_trace(move |event| {
                if let ProducerTraceEventData::KeyFrame { .. } = event {
                    keys.lock().unwrap().push(began.elapsed());
                }
            })
            .detach();
    }

    // A consumer for key frame requests and for the frames as the node forwards them.
    let recv_socket = UdpSocket::bind("127.0.0.1:0").expect("bind receiver");
    let recv_transport = node.plain_recv_transport(recv_socket.local_addr().unwrap().port()).await;
    let consumer_capabilities: RtpCapabilities = serde_json::from_value(capabilities.clone()).unwrap();
    let consumer = recv_transport
        .consume(ConsumerOptions::new(producer.id(), consumer_capabilities))
        .await
        .expect("consumer");
    let media_pt = consumer.rtp_parameters().codecs[0].payload_type();
    let vp8 = consumer.rtp_parameters().codecs[0].mime_type().as_str().eq_ignore_ascii_case("video/VP8");
    eprintln!("consumer codec {} (pt {media_pt})", consumer.rtp_parameters().codecs[0].mime_type().as_str());
    // (time, bytes, key) per frame at the far side.
    let frames = Arc::new(Mutex::new(Vec::<(Duration, u64, bool)>::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let receiver = {
        let (frames, stop) = (frames.clone(), stop.clone());
        std::thread::spawn(move || {
            recv_socket.set_read_timeout(Some(Duration::from_millis(20))).unwrap();
            let mut buffer = [0u8; 2048];
            let mut current: Option<(u32, u64, bool)> = None;
            while !stop.load(Ordering::Relaxed) {
                let Ok((len, _)) = recv_socket.recv_from(&mut buffer) else {
                    continue;
                };
                let Some((pt, marker, ts, payload)) = rtp_payload(&buffer[..len]) else {
                    continue;
                };
                if pt != media_pt {
                    continue;
                }
                let key = if vp8 { vp8_key(payload) } else { false };
                let at = began.elapsed();
                match &mut current {
                    Some((t, bytes, k)) if *t == ts => {
                        *bytes += payload.len() as u64;
                        *k |= key;
                    }
                    _ => {
                        if let Some((_, bytes, k)) = current.take() {
                            frames.lock().unwrap().push((at, bytes, k));
                        }
                        current = Some((ts, payload.len() as u64, key));
                    }
                }
                if marker && let Some((_, bytes, k)) = current.take() {
                    frames.lock().unwrap().push((at, bytes, k));
                }
            }
        })
    };

    // The phases, one row per stats message from the page.
    let mut rows = String::from("t_s,phase,limit_bps,available_outgoing_bps,target_bps,sent_bps,bytes_sent_bps,node_received_bps,relay_queued_ms_max,relay_dropped_over_limit,relay_dropped_loss,frames_encoded,frame_width,frame_height,fps,quality_limitation,retransmitted_bps\n");
    let mut phase_starts = Vec::new();
    let mut requests = Vec::new();
    let mut previous: Option<(Duration, crate::relay::Counters, u64, f64, f64, f64)> = None;
    let mut summary = String::new();
    let mut per_phase: Vec<Vec<(f64, f64, f64)>> = vec![Vec::new(); phases.len()];
    for (index, (name, limits)) in phases.iter().enumerate() {
        relay.set_limits(*limits);
        let start = began.elapsed();
        phase_starts.push(start);
        eprintln!("[{:7.1} s] phase {index} {name}", start.as_secs_f64());
        let mut asked = false;
        let deadline = tokio::time::Instant::now() + phase_len;
        loop {
            if !asked && began.elapsed() >= start + phase_len / 2 {
                let _ = consumer.request_key_frame().await;
                requests.push((index, began.elapsed()));
                asked = true;
            }
            let line = tokio::select! {
                line = lines.next_line() => line,
                _ = tokio::time::sleep_until(deadline) => break,
                _ = tokio::time::sleep(Duration::from_millis(50)) => continue,
            };
            let Ok(Some(line)) = line else {
                eprintln!("stdin closed during the phases");
                break;
            };
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let Some(stats) = message.get("stats") else {
                continue;
            };
            let t = began.elapsed();
            let counters = relay.sample();
            let node_bytes = producer.get_stats().await.ok().and_then(|s| s.into_iter().next()).map_or(0, |s| s.byte_count);
            let bytes_sent = stats["bytesSent"].as_f64().unwrap_or(0.0);
            let retransmitted = stats["retransmittedBytesSent"].as_f64().unwrap_or(0.0);
            let encoded = stats["framesEncoded"].as_f64().unwrap_or(0.0);
            if let Some((pt, pc, pnode, pbytes, pretx, pframes)) = previous {
                let span = (t - pt).as_secs_f64().max(0.001);
                let rate = |a: u64, b: u64| ((a.saturating_sub(b)) as f64 * 8.0 / span) as u64;
                let sent = rate(counters.in_bytes, pc.in_bytes);
                let available = stats["availableOutgoingBitrate"].as_f64().unwrap_or(0.0);
                let _ = writeln!(
                    rows,
                    "{:.3},{name},{},{:.0},{},{sent},{:.0},{},{:.1},{},{},{:.0},{},{},{},{},{:.0}",
                    t.as_secs_f64(),
                    limits.rate_bps.map(|v| v.to_string()).unwrap_or_default(),
                    available,
                    stats["targetBitrate"].as_f64().map(|v| format!("{v:.0}")).unwrap_or_default(),
                    (bytes_sent - pbytes) * 8.0 / span,
                    rate(node_bytes, pnode),
                    counters.queued_ms_max,
                    counters.dropped_over_limit - pc.dropped_over_limit,
                    counters.dropped_loss - pc.dropped_loss,
                    encoded - pframes,
                    stats["frameWidth"],
                    stats["frameHeight"],
                    stats["framesPerSecond"],
                    stats["qualityLimitationReason"].as_str().unwrap_or(""),
                    (retransmitted - pretx) * 8.0 / span,
                );
                per_phase[index].push(((t - start).as_secs_f64(), sent as f64, available));
                eprintln!(
                    "  {:6.1} s  available {:>9.0}  target {:>9}  sent {:>8}  relay queue {:>5.1} ms  drops {}  {}x{}@{}",
                    t.as_secs_f64(),
                    available,
                    stats["targetBitrate"],
                    sent,
                    counters.queued_ms_max,
                    counters.dropped_over_limit - pc.dropped_over_limit,
                    stats["frameWidth"],
                    stats["frameHeight"],
                    stats["framesPerSecond"],
                );
            }
            previous = Some((t, counters, node_bytes, bytes_sent, retransmitted, encoded));
        }
    }
    send(json!({ "done": true }));
    stop.store(true, Ordering::Relaxed);
    let _ = receiver.join();
    relay.stop();

    let frames = frames.lock().unwrap().clone();
    let node_keys = key_frames_at_node.lock().unwrap().clone();
    let _ = writeln!(summary, "Chromium baseline, phases of {phase_len:?}");
    for (index, (name, limits)) in phases.iter().enumerate() {
        let start = phase_starts[index];
        let end = phase_starts.get(index + 1).copied().unwrap_or(began.elapsed());
        let _ = writeln!(summary, "\nphase {index} {name}");
        let late: Vec<&(f64, f64, f64)> = per_phase[index].iter().filter(|r| r.0 >= 8.0).collect();
        if let Some(limit) = limits.rate_bps {
            let lowest = late.iter().map(|r| r.1).fold(f64::INFINITY, f64::min);
            let mean = late.iter().map(|r| r.1).sum::<f64>() / late.len().max(1) as f64;
            let highest_available = per_phase[index].iter().filter(|r| r.0 >= 3.0).map(|r| r.2).fold(0.0, f64::max);
            let _ = writeln!(
                summary,
                "  from 8 s: sent lowest {lowest:.0} mean {mean:.0} bps against {limit} ({:.2} at the lowest), highest available outgoing from 3 s {highest_available:.0} ({:.2} of the limit)",
                lowest / limit as f64,
                highest_available / limit as f64
            );
        }
        let in_phase: Vec<&(Duration, u64, bool)> = frames.iter().filter(|f| f.0 >= start && f.0 < end).collect();
        if !in_phase.is_empty() {
            let average = in_phase.iter().map(|f| f.1).sum::<u64>() as f64 / in_phase.len() as f64;
            let largest = in_phase.iter().map(|f| f.1).max().unwrap_or(0);
            let keys: Vec<String> = in_phase.iter().filter(|f| f.2).map(|f| format!("{} B at {:.2} s", f.1, f.0.as_secs_f64())).collect();
            let _ = writeln!(summary, "  frames {} average {average:.0} B largest {largest} B, key frames: {}", in_phase.len(), keys.join(", "));
        }
        for (_, asked) in requests.iter().filter(|(p, _)| *p == index) {
            let first = node_keys.iter().find(|t| *t >= asked).map(|t| (*t - *asked).as_millis());
            let whole = frames.iter().find(|f| f.2 && f.0 >= *asked).map(|f| (f.0 - *asked).as_millis());
            let _ = writeln!(summary, "  key frame asked at {:.2} s: first packet at the node after {first:?} ms, whole frame at the far side after {whole:?} ms", asked.as_secs_f64());
        }
    }
    eprint!("{summary}");
    let write = |name: &str, text: &str| {
        std::fs::File::create(out.join(name)).and_then(|mut f| f.write_all(text.as_bytes())).expect("write");
    };
    write("seconds.csv", &rows);
    write("summary.txt", &summary);
    let mut frame_csv = String::from("t_s,bytes,key\n");
    for f in &frames {
        let _ = writeln!(frame_csv, "{:.3},{},{}", f.0.as_secs_f64(), f.1, u8::from(f.2));
    }
    write("frames.csv", &frame_csv);
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vp8_key_frames() {
        // No extension, start of partition 0, key frame bit clear.
        assert!(vp8_key(&[0x10, 0x00]));
        assert!(!vp8_key(&[0x10, 0x01]));
        // With a 15 bit picture id.
        assert!(vp8_key(&[0x90, 0x80, 0x81, 0x02, 0x00]));
        assert!(!vp8_key(&[0x00, 0x00]));
    }
}
