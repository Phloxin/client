// Probe 1: does the engine work as a sender against the node's mediasoup transports?
// (.plans/native-media-engine.md, section 7, and .plans/native-media-engine-m2-engine.md D20.)
//
// The engine is the `pylon-media-host` sidecar, started with `--insecure-plain --test-hooks` and
// driven over its control protocol with the synthetic source and no E2EE. It only sees what a
// client would get over the wire: the transport parameters and the router's capabilities.
//
// Every check is judged from the node's side, with the sidecar's events and statistics where the
// engine's own numbers are needed:
//   1. ICE and DTLS complete.
//   2. The producer receives RTP (packet count, score, nothing lost).
//   3. Transport-wide feedback arrives and the engine reports a bandwidth estimate.
//   4. Dropped packets are NACKed by the node and resent over RTX (`test_drop_media`).
//   5. A key frame request from the node reaches the engine as an event.
//   6. A consumer on a second transport receives the stream without holes.
//   7. With its stdin closed and no `close`, the sidecar exits within 2 s with status 0.
//
// Env: MAX_MBPS (8), START_KBPS (1500), FPS (30), BURSTS ("5,40"), PROBE_CODEC (H264, or AV1:
// then the source is the pattern at 1920x1080 and FPS through the hardware encoder, AV1 step 2 Q11).

use std::{
    net::UdpSocket,
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
use serde_json::json;

use crate::{env, node, sidecar::Sidecar};

// ─── The receiving end of the consumer ───────────────────────────

#[derive(Default)]
struct Received {
    media: u64,
    unique: u64,
    rtx: u64,
    first: Option<u16>,
    /// Highest sequence number seen, counted from `first` without wrapping.
    span: u64,
    seen: Vec<bool>,
}

fn run_receiver(socket: UdpSocket, media_pt: u8, rtx_pt: Option<u8>, received: Arc<Mutex<Received>>, stop: Arc<AtomicBool>) {
    socket.set_read_timeout(Some(Duration::from_millis(20))).unwrap();
    let mut buffer = [0u8; 2048];
    received.lock().unwrap().seen = vec![false; 1 << 20];

    while !stop.load(Ordering::Relaxed) {
        let Ok((len, _)) = socket.recv_from(&mut buffer) else {
            continue;
        };
        if len < 12 || (192..=223).contains(&buffer[1]) {
            continue;
        }
        let pt = buffer[1] & 0x7f;
        let seq = u16::from_be_bytes([buffer[2], buffer[3]]);
        let mut received = received.lock().unwrap();
        if pt == media_pt {
            received.media += 1;
            let first = *received.first.get_or_insert(seq);
            // Offset from the first packet, unwrapped around the highest one seen so far.
            let near = received.span as i64;
            let mut offset = seq.wrapping_sub(first) as i64;
            while offset < near - 32768 {
                offset += 65536;
            }
            let offset = offset as usize;
            if offset < received.seen.len() && !received.seen[offset] {
                received.seen[offset] = true;
                received.unique += 1;
                received.span = received.span.max(offset as u64);
            }
        } else if Some(pt) == rtx_pt {
            received.rtx += 1;
        }
    }
}

// ─── The checks ──────────────────────────────────────────────────

fn check(results: &mut Vec<(String, bool)>, name: &str, pass: bool, detail: String) {
    println!("{} {name}: {detail}", if pass { "PASS" } else { "FAIL" });
    results.push((name.to_owned(), pass));
}

pub async fn run() -> i32 {
    let max_bps: u64 = env::<u64>("MAX_MBPS", 8) * 1_000_000;
    let start_bps: u64 = env::<u64>("START_KBPS", 1500) * 1000;
    let fps: u64 = env("FPS", 30);
    let bursts: Vec<u64> = std::env::var("BURSTS")
        .unwrap_or_else(|_| "5,40".into())
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    let began = Instant::now();
    let at = move || began.elapsed().as_secs_f64() * 1000.0;

    // The node: worker, WebRtcServer, router, send transport, as pylon-sfu makes them.
    let node = node::Node::start().await;
    let send_transport = node.send_transport().await;

    send_transport
        .on_ice_state_change(move |state| println!("[node {:7.1} ms] ice {state:?}", at()))
        .detach();
    send_transport
        .on_dtls_state_change(move |state| println!("[node {:7.1} ms] dtls {state:?}", at()))
        .detach();

    // What goes over the wire to a client: `RoutingParams`.
    let capabilities = node.capabilities();
    let transport_parameters = node::transport_parameters(&send_transport);
    println!(
        "node: ice_lite={} candidates={} dtls role={} fingerprints={}",
        transport_parameters["ice_parameters"]["iceLite"],
        transport_parameters["ice_candidates"],
        transport_parameters["dtls_parameters"]["role"],
        transport_parameters["dtls_parameters"]["fingerprints"]
            .as_array()
            .map(|f| f.iter().map(|f| f["algorithm"].as_str().unwrap_or("?")).collect::<Vec<_>>().join(","))
            .unwrap_or_default(),
    );

    // H264 from the synthetic source, as before AV1. AV1 from the pattern through the encoder.
    let codec = crate::sidecar::codec();
    let (source, video) = if codec == "H264" {
        (
            json!({ "synthetic": { "fps": fps } }),
            json!({ "start_bitrate": start_bps, "max_bitrate": max_bps }),
        )
    } else {
        (
            json!({ "pattern": { "width": 1920, "height": 1080, "fps": fps } }),
            json!({ "start_bitrate": start_bps, "max_bitrate": max_bps, "codec": codec }),
        )
    };
    println!("codec {codec}, source {source}");

    // The engine, from that JSON alone.
    let mut sidecar = match Sidecar::start(&["--insecure-plain", "--test-hooks"]) {
        Ok(sidecar) => sidecar,
        Err(error) => {
            println!("FAIL sidecar: {error}");
            return 1;
        }
    };
    let opened = sidecar
        .hello_and_open(json!({
            "router_rtp_capabilities": capabilities,
            "transport": transport_parameters,
            "e2ee": null,
            "source": source,
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
    println!("sidecar rtp parameters: {}", opened["rtp_parameters"]);
    // PROBE_PREVIEW asks for the sharer's preview after `open` (M6 preview step 1, R8).
    let previewing = sidecar.start_preview_schedule();

    // `ConnectTransport`, then `CreateSource`, then media.
    send_transport
        .connect(WebRtcTransportRemoteParameters {
            dtls_parameters: serde_json::from_value(opened["dtls_parameters"].clone()).expect("dtls parameters"),
        })
        .await
        .expect("connect send transport");
    let producer = node::produce(&send_transport, opened["rtp_parameters"].clone()).await;
    println!("node: producer {} type={:?}", producer.id(), producer.r#type());
    sidecar.send(json!({ "start": {} })).await.expect("start");
    let log = sidecar.log.clone();

    // The node's own record of the key frames it saw and the PLIs it sent.
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

    let mut results = Vec::new();
    let producer_stat = async || producer.get_stats().await.ok().and_then(|s| s.into_iter().next());

    // 1. ICE and DTLS.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let engine_connected = log.lock().unwrap().connected_ms.is_some();
        let node_connected = send_transport.dtls_state() == DtlsState::Connected
            && matches!(send_transport.ice_state(), IceState::Connected | IceState::Completed);
        if (engine_connected && node_connected) || Instant::now() > deadline {
            break;
        }
        if let Some(error) = log.lock().unwrap().fatal() {
            println!("engine stopped: {error}");
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    {
        let log = log.lock().unwrap();
        check(
            &mut results,
            "1 ICE and DTLS",
            log.connected_ms.is_some()
                && send_transport.dtls_state() == DtlsState::Connected
                && matches!(send_transport.ice_state(), IceState::Connected | IceState::Completed),
            format!(
                "node ice={:?} dtls={:?} tuple={:?}, sidecar opened at {:?} ms and connected at {:?} ms (sidecar clock), ice {:?}",
                send_transport.ice_state(),
                send_transport.dtls_state(),
                send_transport.ice_selected_tuple(),
                log.opened_ms,
                log.connected_ms,
                log.ice_states,
            ),
        );
    }

    // 2 and 3. Let it send for a while with nothing in the way.
    println!("\n{:>5} {:>9} {:>9} {:>6} {:>6} {:>10} {:>10} {:>7}", "t(s)", "packets", "node bps", "score", "lost", "estimate", "target", "queued");
    for second in 1..=8 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let stat = producer_stat().await;
        let log = log.lock().unwrap();
        let stats = log.last_stats();
        println!(
            "{:>5} {:>9} {:>9} {:>6} {:>6} {:>10} {:>10} {:>7}",
            second,
            stat.as_ref().map_or(0, |s| s.packet_count),
            stat.as_ref().map_or(0, |s| s.bitrate),
            stat.as_ref().map_or(0, |s| s.score),
            stat.as_ref().map_or(0, |s| s.packets_lost),
            stats.and_then(|s| s["bandwidth_estimate_bps"].as_u64()).unwrap_or(0),
            log.stat("target_bitrate_bps"),
            log.stat("queued_packets"),
        );
    }
    let clean = producer_stat().await;
    {
        let log = log.lock().unwrap();
        check(
            &mut results,
            "2 producer receives RTP",
            clean.as_ref().is_some_and(|s| s.packet_count > 500 && s.score >= 9 && s.packets_lost == 0),
            format!(
                "engine sent {} media packets in {} frames ({} key) by its last statistics, node counted {:?} packets, score {:?}, lost {:?}, jitter {:?}",
                log.stat("media_packets_sent"),
                log.stat("frames_sent"),
                log.stat("key_frames_sent"),
                clean.as_ref().map(|s| s.packet_count),
                clean.as_ref().map(|s| s.score),
                clean.as_ref().map(|s| s.packets_lost),
                clean.as_ref().map(|s| s.jitter),
            ),
        );

        // The estimate as the sidecar reports it, once a second.
        let estimates: Vec<u64> = log.stats.iter().filter_map(|s| s["bandwidth_estimate_bps"].as_u64()).collect();
        let highest = estimates.iter().copied().max();
        check(
            &mut results,
            "3 bandwidth estimate from the node's feedback",
            estimates.len() > 3 && highest > Some(start_bps),
            format!(
                "{} estimates (one per statistics event), first {:?} bps, highest {:?} bps, last {:?} bps (start {} bps, cap {} bps)",
                estimates.len(),
                estimates.first(),
                highest,
                estimates.last(),
                start_bps,
                max_bps,
            ),
        );
    }

    // 6 is set up now so the bursts below also have to come out the far side.
    let recv_socket = UdpSocket::bind("127.0.0.1:0").expect("bind receiver");
    let recv_transport = node
        .plain_recv_transport(recv_socket.local_addr().unwrap().port())
        .await;

    let consumer_capabilities: RtpCapabilities = serde_json::from_value(capabilities.clone()).unwrap();
    let key_requests_before = log.lock().unwrap().key_frame_requests.len();
    let consumer = recv_transport
        .consume(ConsumerOptions::new(producer.id(), consumer_capabilities))
        .await
        .expect("consumer");
    let consumer_parameters = consumer.rtp_parameters().clone();
    let media_pt = consumer_parameters.codecs[0].payload_type();
    let rtx_pt = consumer_parameters.codecs.get(1).map(|c| c.payload_type());

    let received = Arc::new(Mutex::new(Received::default()));
    let stop_receiver = Arc::new(AtomicBool::new(false));
    let receiver_thread = {
        let (received, stop) = (received.clone(), stop_receiver.clone());
        std::thread::spawn(move || run_receiver(recv_socket, media_pt, rtx_pt, received, stop))
    };

    // 5. A new consumer makes the node ask for a key frame, and nothing is forwarded before one.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let after_consume = log.lock().unwrap().key_frame_requests.len();
    let forwarded_after_consume = received.lock().unwrap().media;

    tokio::time::sleep(Duration::from_millis(1500)).await;
    let before_explicit = log.lock().unwrap().key_frame_requests.len();
    let key_frames_before_explicit = log.lock().unwrap().stat("key_frames_sent");
    consumer.request_key_frame().await.expect("request key frame");
    tokio::time::sleep(Duration::from_millis(3000)).await;
    {
        let log = log.lock().unwrap();
        let after_explicit = log.key_frame_requests.len();
        check(
            &mut results,
            "5 key frame requests reach the engine",
            after_consume > key_requests_before && after_explicit > before_explicit && forwarded_after_consume > 0,
            format!(
                "on consume: {} request(s) and {} packets forwarded within 1.5 s, on request_key_frame: {} more.\n     engine got requests at (sidecar ms) {:?}\n     engine key frames sent: {} in all, {} since the explicit request\n     node {:?}",
                after_consume - key_requests_before,
                forwarded_after_consume,
                after_explicit - before_explicit,
                log.key_frame_requests,
                log.stat("key_frames_sent"),
                log.stat("key_frames_sent") - key_frames_before_explicit,
                node_key_events.lock().unwrap(),
            ),
        );
    }

    // 4. Throw media packets away between str0m and the socket.
    let mut repaired_all = true;
    let mut burst_lines = Vec::new();
    for &burst in &bursts {
        let before = producer_stat().await;
        let rtx_before = log.lock().unwrap().stat("rtx_packets_sent");
        if let Err(error) = sidecar.send(json!({ "test_drop_media": { "count": burst } })).await {
            println!("test_drop_media: {error}");
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
        let after = producer_stat().await;
        let rtx_after = log.lock().unwrap().stat("rtx_packets_sent");

        let delta = |f: fn(&mediasoup::producer::ProducerStat) -> u64| {
            after.as_ref().map_or(0, f) - before.as_ref().map_or(0, f)
        };
        let repaired = delta(|s| s.packets_repaired);
        let lost_after = after.as_ref().map_or(0, |s| s.packets_lost);
        let lost_before = before.as_ref().map_or(0, |s| s.packets_lost);
        // The node's `packets_lost` counts what never came on the main stream, repaired or not,
        // so it is printed and not judged. The far side of the consumer (check 6) is the proof.
        repaired_all &= repaired >= burst;
        burst_lines.push(format!(
            "dropped {burst}: node sent {} NACKs for {} packets, got {} retransmissions, repaired {}, lost {} -> {}, score {:?}, engine sent {} RTX packets (by its statistics, up to 1 s behind)",
            delta(|s| s.nack_count),
            delta(|s| s.nack_packet_count),
            delta(|s| s.packets_retransmitted),
            repaired,
            lost_before,
            lost_after,
            after.as_ref().map(|s| s.score),
            rtx_after - rtx_before,
        ));
    }
    check(
        &mut results,
        "4 NACK and RTX",
        repaired_all && !bursts.is_empty(),
        format!("\n     {}", burst_lines.join("\n     ")),
    );

    // 6. What came out of the consumer.
    tokio::time::sleep(Duration::from_secs(1)).await;
    {
        let received = received.lock().unwrap();
        let holes = (received.span + 1).saturating_sub(received.unique);
        check(
            &mut results,
            "6 consumer on a second transport",
            received.unique > 500 && holes == 0,
            format!(
                "{} media packets ({} unique over a span of {}), {} holes after {} packets dropped at the sender, consumer type {:?}",
                received.media,
                received.unique,
                received.span + 1,
                holes,
                bursts.iter().sum::<u64>(),
                consumer.r#type(),
            ),
        );
    }

    stop_receiver.store(true, Ordering::Relaxed);
    let _ = receiver_thread.join();

    {
        let log = log.lock().unwrap();
        let max_queued = log.stats.iter().filter_map(|s| s["queued_packets"].as_u64()).max();
        println!(
            "\nengine: dtls {:?}, {} statistics events, send queue at most {:?} packets, {} RTX packets in all, errors {:?}",
            log.last_stats().map(|s| s["dtls_version"].clone()),
            log.stats.len(),
            max_queued,
            log.stat("rtx_packets_sent"),
            log.errors,
        );
        println!("engine last statistics: {}", log.last_stats().cloned().unwrap_or_default());
    }
    if let Ok(stats) = send_transport.get_stats().await {
        println!("node transport stats: {stats:?}");
    }
    if let Some(stat) = producer_stat().await {
        println!("node producer stats: {stat:?}");
    }

    // 7. The host goes away without a word.
    let (took, code) = sidecar.close_stdin(Duration::from_secs(2)).await;
    {
        let log = log.lock().unwrap();
        check(
            &mut results,
            "7 sidecar exits when its stdin closes",
            code == Some(0) && took <= Duration::from_secs(2),
            format!(
                "exit status {code:?} after {:.1} ms, last message {:?}, stdout lines that were not JSON: {}",
                took.as_secs_f64() * 1000.0,
                log.closed,
                log.not_json.len(),
            ),
        );
    }
    if code.is_none() {
        sidecar.close(Duration::from_secs(1)).await;
    }
    // The pictures go to PROBE_PREVIEW_OUT when set. Not a check of its own.
    if previewing {
        let dir = std::env::var_os("PROBE_PREVIEW_OUT").map(std::path::PathBuf::from);
        let log = log.lock().unwrap();
        println!("\n{}", crate::sidecar::write_previews(&log, dir.as_deref()));
        let preview_errors: Vec<_> = log.errors.iter().filter(|e| e["message"].as_str().is_some_and(|m| m.starts_with("preview"))).collect();
        println!("preview errors: {preview_errors:?}");
    }

    let failed = results.iter().filter(|(_, pass)| !pass).count();
    println!("\n{} of {} checks passed", results.len() - failed, results.len());
    if failed == 0 { 0 } else { 1 }
}
