// Screen capture through the portal and the VA-API encoder without the transport, for measuring
// them alone (.plans/native-media-engine-m5b-capture.md, T1 and T3):
//   cargo run --release --features capture --example capture_encode -- \
//     seconds=10 fps=60 bitrate=8000000 out=/tmp/m5b/t1.h264 csv=/tmp/m5b/t1.csv json=/tmp/m5b/t1.json \
//     [token=/tmp/m5b/token] [wait=300] [max_fps=60]
// Opens the portal's dialog (unless the restore token in `token` is honoured), encodes what comes
// for `seconds` at no more than `fps`, and writes the Annex-B stream, one CSV line per frame
// (frame,ms,bytes,key,encode_ms,delay_ms) and the totals as JSON. The new restore token goes back
// into `token`.

use std::{
    collections::HashMap,
    io::Write,
    sync::mpsc,
    time::{Duration, Instant},
};

use pylon_media::{
    SourceControl,
    video::{
        EncoderConfig, FrameEncoder, FrameProducer, Produced, VaapiEncoder,
        capture::{CaptureEvent, ScreenCapture, fourcc_text},
    },
};
use serde_json::json;

fn median_max(values: &mut [f64]) -> (Option<f64>, Option<f64>) {
    if values.is_empty() {
        return (None, None);
    }
    values.sort_by(f64::total_cmp);
    (Some(values[values.len() / 2]), Some(values[values.len() - 1]))
}

fn main() {
    let args: HashMap<String, String> = std::env::args()
        .skip(1)
        .filter_map(|a| a.split_once('=').map(|(k, v)| (k.to_owned(), v.to_owned())))
        .collect();
    let get = |k: &str, d: &str| args.get(k).cloned().unwrap_or_else(|| d.to_owned());
    let num = |k: &str, d: &str| get(k, d).parse::<u64>().expect(k);
    let seconds = num("seconds", "10");
    let fps = num("fps", "60") as u32;
    let bitrate = num("bitrate", "8000000");
    let wait = Duration::from_secs(num("wait", "300"));
    // max_fps=<n> asks the compositor for at most that rate (M5b D13), 0 for no limit.
    let max_fps = Some(num("max_fps", "0") as u32).filter(|f| *f > 0);
    let token_path = args.get("token").cloned();
    let token = token_path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty());

    let filter = std::env::var("PYLON_MEDIA_LOG").unwrap_or_else(|_| "info".into());
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_env_filter(tracing_subscriber::EnvFilter::try_new(&filter).unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")))
        .init();
    let (events_tx, events) = mpsc::channel();
    let asked = Instant::now();
    eprintln!("asking the portal (restore token given: {})", token.is_some());
    let capture = ScreenCapture::start(token.clone(), max_fps, move |event| {
        let _ = events_tx.send((Instant::now(), event));
    })
    .expect("capture");
    let info = match events.recv_timeout(wait) {
        Ok((_, CaptureEvent::Ready(info))) => info,
        Ok((_, other)) => {
            eprintln!("capture did not start: {other:?}");
            std::process::exit(1);
        }
        Err(_) => {
            eprintln!("no answer from the portal within {} s", wait.as_secs());
            std::process::exit(3);
        }
    };
    let ready_ms = asked.elapsed().as_secs_f64() * 1000.0;
    eprintln!(
        "ready after {ready_ms:.0} ms: {}x{} {} modifier {:?} dmabuf {} source {} cursor {}",
        info.width,
        info.height,
        fourcc_text(info.fourcc),
        info.modifier.map(|m| format!("{m:#018x}")),
        info.dmabuf,
        info.source,
        info.cursor
    );
    if let (Some(path), Some(new)) = (&token_path, &info.restore_token) {
        std::fs::write(path, new).expect("token");
    }

    let mut producer = capture.producer(fps).expect("producer");
    let mut encoder = VaapiEncoder::new(EncoderConfig {
        width: info.width.min(4096),
        height: info.height.min(4096),
        fps,
        start_bitrate: bitrate,
        filler: false,
    })
    .expect("encoder");
    let control = SourceControl::default();
    let mut out = std::fs::File::create(get("out", "/tmp/m5b/t1.h264")).expect("out");
    let mut csv = std::fs::File::create(get("csv", "/tmp/m5b/t1.csv")).expect("csv");
    writeln!(csv, "frame,ms,bytes,key,encode_ms,delay_ms,width,height").unwrap();

    let began = Instant::now();
    let interval = producer.interval();
    let (mut frames, mut keys, mut bytes) = (0u64, 0u64, 0u64);
    let (mut encode_ms, mut delay_ms) = (Vec::new(), Vec::new());
    let mut changes = Vec::new();
    let mut ended = false;
    let mut sizes = Vec::new();
    while began.elapsed() < Duration::from_secs(seconds) {
        for (at, event) in events.try_iter() {
            eprintln!("event at {:.0} ms: {event:?}", at.saturating_duration_since(began).as_secs_f64() * 1000.0);
            match event {
                CaptureEvent::Changed { width, height } => changes.push(json!({
                    "ms": at.saturating_duration_since(began).as_secs_f64() * 1000.0, "width": width, "height": height
                })),
                CaptureEvent::Ended => ended = true,
                _ => {}
            }
        }
        let frame = match producer.next_frame(&control, Instant::now() + interval).expect("frame") {
            Produced::Frame(frame) => frame,
            Produced::Idle => continue,
            Produced::End => {
                ended = true;
                break;
            }
        };
        let start = Instant::now();
        let delay = start.saturating_duration_since(frame.capture_time).as_secs_f64() * 1000.0;
        let packet = encoder.encode(&frame, bitrate, 1, frames == 0).expect("encode");
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        out.write_all(&packet.data).unwrap();
        writeln!(
            csv,
            "{frames},{:.1},{},{},{ms:.3},{delay:.3},{},{}",
            start.saturating_duration_since(began).as_secs_f64() * 1000.0,
            packet.data.len(),
            u8::from(packet.key),
            frame.width,
            frame.height
        )
        .unwrap();
        if sizes.last() != Some(&(frame.width, frame.height)) {
            sizes.push((frame.width, frame.height));
        }
        frames += 1;
        keys += u64::from(packet.key);
        bytes += packet.data.len() as u64;
        encode_ms.push(ms);
        delay_ms.push(delay);
    }
    let elapsed = began.elapsed().as_secs_f64();
    let mut report = None;
    control.update_report(|r| report = r.capture.clone());
    let report = report.unwrap_or_default();
    let (encode_median, encode_max) = median_max(&mut encode_ms);
    let (delay_median, delay_max) = median_max(&mut delay_ms);
    let totals = json!({
        "ready_ms": ready_ms,
        "restore_token_given": token.is_some(),
        "restore_token_returned": info.restore_token.is_some(),
        "width": info.width,
        "height": info.height,
        "format": fourcc_text(info.fourcc),
        "modifier": info.modifier.map(|m| format!("{m:#018x}")),
        "dmabuf": info.dmabuf,
        "source": info.source,
        "cursor": info.cursor,
        "buffer_path": report.buffer_path,
        "seconds": elapsed,
        "frames_encoded": frames,
        "key_frames": keys,
        "bytes": bytes,
        "bitrate_bps": (bytes as f64 * 8.0 / elapsed).round(),
        "compositor_frames_delivered": report.frames_delivered,
        "compositor_fps": report.frames_delivered as f64 / elapsed,
        "frames_taken": report.frames_taken,
        "frames_dropped_rate": report.frames_dropped_rate,
        "encode_ms_median": encode_median,
        "encode_ms_max": encode_max,
        "capture_delay_ms_median": delay_median,
        "capture_delay_ms_max": delay_max,
        "sizes": sizes,
        "capture_changed": changes,
        "ended_by_itself": ended,
    });
    std::fs::write(get("json", "/tmp/m5b/t1.json"), serde_json::to_string_pretty(&totals).unwrap() + "\n").expect("json");
    println!("{}", serde_json::to_string_pretty(&totals).unwrap());
    drop(producer);
    drop(capture);
}
