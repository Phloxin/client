// Windows Graphics Capture and the Windows hardware encoder without the transport, for measuring
// them alone: the Windows twin of capture_encode (.plans/native-media-engine-m7-5-windows-capture.md,
// C13). Run in the desktop session (pylon-scratch\runtask.ps1), with FFmpeg's DLLs on PATH or
// beside the program:
//   cargo run --release -p pylon-media --features capture --example capture_encode_windows -- \
//     seconds=20 fps=60 bitrate=8000000 target=primary max=1920x1080 [max_fps=60] \
//     out=C:\x\t.h264 csv=C:\x\t.csv json=C:\x\t.json
// `target` is `primary`, `window:<handle>` or `monitor:<x>,<y>` (a point in physical pixels).
// Encodes what comes for `seconds` (or until the item closes) at no more than `fps`, keeping the
// last frame as the pipeline does, and writes the Annex-B stream, one CSV line per frame
// (frame,ms,bytes,key,encode_ms,delay_ms,width,height) and the totals as JSON.

#[cfg(not(windows))]
fn main() {
    eprintln!("capture_encode_windows runs on Windows only, capture_encode is Linux's");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    imp::run();
}

#[cfg(windows)]
mod imp {
    use std::{
        collections::HashMap,
        io::Write,
        sync::mpsc,
        time::{Duration, Instant},
    };

    use pylon_media::{
        SourceControl,
        video::{
            FrameEncoder, FrameProducer, Produced,
            capture::{CaptureEvent, CaptureTarget, ScreenCapture, init_runtime, make_dpi_aware},
        },
    };
    use serde_json::json;

    /// Median, 99th percentile and maximum.
    fn spread(values: &mut [f64]) -> (Option<f64>, Option<f64>, Option<f64>) {
        if values.is_empty() {
            return (None, None, None);
        }
        values.sort_by(f64::total_cmp);
        let n = values.len();
        (Some(values[n / 2]), Some(values[(n * 99 / 100).min(n - 1)]), Some(values[n - 1]))
    }

    fn target(text: &str) -> Option<CaptureTarget> {
        if text == "primary" {
            return None;
        }
        if let Some(handle) = text.strip_prefix("window:") {
            return Some(CaptureTarget::Window(handle.parse().expect("window handle")));
        }
        if let Some(point) = text.strip_prefix("monitor:") {
            let (x, y) = point.split_once(',').expect("monitor:<x>,<y>");
            return Some(CaptureTarget::Monitor { x: x.parse().expect("x"), y: y.parse().expect("y") });
        }
        panic!("target is primary, window:<handle> or monitor:<x>,<y>");
    }

    pub fn run() {
        let args: HashMap<String, String> = std::env::args()
            .skip(1)
            .filter_map(|a| a.split_once('=').map(|(k, v)| (k.to_owned(), v.to_owned())))
            .collect();
        let get = |k: &str, d: &str| args.get(k).cloned().unwrap_or_else(|| d.to_owned());
        let num = |k: &str, d: &str| get(k, d).parse::<u64>().expect(k);
        let seconds = num("seconds", "10");
        let fps = num("fps", "60") as u32;
        let bitrate = num("bitrate", "8000000");
        let max_fps = Some(num("max_fps", "0") as u32).filter(|f| *f > 0);
        let max = get("max", "1920x1080");
        let (max_width, max_height) = max.split_once('x').map(|(w, h)| (w.parse().expect("max"), h.parse().expect("max"))).expect("max=<w>x<h>");
        let target_text = get("target", "primary");

        let filter = std::env::var("PYLON_MEDIA_LOG").unwrap_or_else(|_| "info".into());
        tracing_subscriber::fmt()
            .with_writer(std::io::stderr)
            .with_ansi(false)
            .with_env_filter(tracing_subscriber::EnvFilter::try_new(&filter).unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")))
            .init();
        make_dpi_aware();
        init_runtime();
        let (events_tx, events) = mpsc::channel();
        let asked = Instant::now();
        let capture = match ScreenCapture::start(target(&target_text), max_fps, move |event| {
            let _ = events_tx.send((Instant::now(), event));
        }) {
            Ok(capture) => capture,
            Err(error) => {
                eprintln!("capture did not start: {error}");
                std::process::exit(1);
            }
        };
        let info = match events.recv_timeout(Duration::from_secs(10)) {
            Ok((_, CaptureEvent::Ready(info))) => info,
            Ok((_, other)) => {
                eprintln!("capture did not start: {other:?}");
                std::process::exit(1);
            }
            Err(_) => {
                eprintln!("no capture within 10 s");
                std::process::exit(3);
            }
        };
        let ready_ms = asked.elapsed().as_secs_f64() * 1000.0;
        eprintln!("ready after {ready_ms:.0} ms: {info:?}");

        let mut producer = capture.producer(fps).expect("producer");
        let mut encoder = capture.encoder(fps, max_width, max_height, bitrate).expect("encoder");
        let control = SourceControl::default();
        let mut out = std::fs::File::create(get("out", "capture.h264")).expect("out");
        let mut csv = std::fs::File::create(get("csv", "capture.csv")).expect("csv");
        writeln!(csv, "frame,ms,bytes,key,encode_ms,delay_ms,width,height").unwrap();

        let began = Instant::now();
        let interval = producer.interval();
        let (mut frames, mut keys, mut bytes) = (0u64, 0u64, 0u64);
        let (mut encode_ms, mut delay_ms) = (Vec::new(), Vec::new());
        let mut changes = Vec::new();
        let mut ended = false;
        let mut sizes = Vec::new();
        // Kept as the pipeline keeps the newest frame (C5).
        let mut last = None;
        let mut per_second: Vec<u64> = vec![0; seconds as usize + 1];
        while began.elapsed() < Duration::from_secs(seconds) {
            for (at, event) in events.try_iter() {
                let ms = at.saturating_duration_since(began).as_secs_f64() * 1000.0;
                eprintln!("event at {ms:.0} ms: {event:?}");
                match event {
                    CaptureEvent::Changed { width, height } => changes.push(json!({ "ms": ms, "width": width, "height": height })),
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
            let at = start.saturating_duration_since(began);
            writeln!(
                csv,
                "{frames},{:.1},{},{},{ms:.3},{delay:.3},{},{}",
                at.as_secs_f64() * 1000.0,
                packet.data.len(),
                u8::from(packet.key),
                frame.width,
                frame.height
            )
            .unwrap();
            if let Some(count) = per_second.get_mut(at.as_secs() as usize) {
                *count += 1;
            }
            if sizes.last() != Some(&(frame.width, frame.height)) {
                sizes.push((frame.width, frame.height));
            }
            frames += 1;
            keys += u64::from(packet.key);
            bytes += packet.data.len() as u64;
            encode_ms.push(ms);
            delay_ms.push(delay);
            last = Some(frame);
        }
        // An end after the last frame.
        for (at, event) in events.try_iter() {
            eprintln!("event at {:.0} ms: {event:?}", at.saturating_duration_since(began).as_secs_f64() * 1000.0);
            ended |= event == CaptureEvent::Ended;
        }
        let elapsed = began.elapsed().as_secs_f64();
        let mut report = None;
        control.update_report(|r| report = r.capture.clone());
        let report = report.unwrap_or_default();
        let (encode_median, encode_p99, encode_max) = spread(&mut encode_ms);
        let (delay_median, delay_p99, delay_max) = spread(&mut delay_ms);
        let totals = json!({
            "target": target_text,
            "ready_ms": ready_ms,
            "width": info.width,
            "height": info.height,
            "source": info.source,
            "adapter": info.adapter,
            "border": info.border,
            "min_update_ms": info.min_update_ms,
            "buffer_path": report.buffer_path,
            "seconds": elapsed,
            "frames_encoded": frames,
            "frames_per_second": per_second,
            "key_frames": keys,
            "bytes": bytes,
            "bitrate_bps": (bytes as f64 * 8.0 / elapsed).round(),
            "frames_delivered": report.frames_delivered,
            "delivered_fps": report.frames_delivered as f64 / elapsed,
            "frames_taken": report.frames_taken,
            "frames_dropped_rate": report.frames_dropped_rate,
            "encode_ms_median": encode_median,
            "encode_ms_p99": encode_p99,
            "encode_ms_max": encode_max,
            "capture_delay_ms_median": delay_median,
            "capture_delay_ms_p99": delay_p99,
            "capture_delay_ms_max": delay_max,
            "input_sizes": sizes,
            "capture_changed": changes,
            "ended_by_itself": ended,
        });
        std::fs::write(get("json", "capture.json"), serde_json::to_string_pretty(&totals).unwrap() + "\n").expect("json");
        println!("{}", serde_json::to_string_pretty(&totals).unwrap());
        // In the pipeline's order: the encoder before the kept frame, so that the capture, which
        // closes its pool once its frames are back, never closes it while the encoder is being
        // torn down on the same device. The other order ended the process with an access
        // violation in two runs of three after a resize (M7.5 report).
        eprintln!("dropping the encoder");
        drop(encoder);
        eprintln!("dropping the last frame");
        drop(last);
        drop(producer);
        eprintln!("stopping the capture");
        drop(capture);
        eprintln!("done");
    }
}
