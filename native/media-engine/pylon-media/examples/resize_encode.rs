// The encoder fed frames whose size keeps changing, as a window being resized gives them (M5b
// D14), from pattern producers of several sizes instead of a capture:
//   cargo run --release --features encode --example resize_encode -- out=/tmp/r.h264 csv=/tmp/r.csv
// For 1.5 s the size changes every 3 frames, then it stays at the last one. Writes the stream and
// one CSV line per frame: frame,ms,input,bytes,key,encode_ms.

use std::{collections::HashMap, io::Write, time::Instant};

use pylon_media::{
    SourceControl,
    video::{EncoderConfig, FrameEncoder, FrameProducer, PatternKind, PatternProducer, Produced, VaapiEncoder},
};

fn main() {
    let args: HashMap<String, String> = std::env::args()
        .skip(1)
        .filter_map(|a| a.split_once('=').map(|(k, v)| (k.to_owned(), v.to_owned())))
        .collect();
    let get = |k: &str, d: &str| args.get(k).cloned().unwrap_or_else(|| d.to_owned());
    let fps = 60;
    let sizes = [(1010, 928), (1040, 948), (1100, 980), (1160, 1012), (1200, 860)];
    let mut producers: Vec<PatternProducer> = sizes
        .iter()
        .map(|&(w, h)| PatternProducer::new(w, h, fps, false, PatternKind::Screen).expect("pattern"))
        .collect();
    let mut encoder = VaapiEncoder::new(EncoderConfig { width: 1920, height: 1080, fps, start_bitrate: 6_000_000, filler: false })
        .expect("encoder");
    let control = SourceControl::default();
    let mut out = std::fs::File::create(get("out", "/tmp/resize.h264")).expect("out");
    let mut csv = std::fs::File::create(get("csv", "/tmp/resize.csv")).expect("csv");
    writeln!(csv, "frame,ms,input,bytes,key,encode_ms").unwrap();
    let began = Instant::now();
    for n in 0..240u64 {
        // Changing for the first 90 frames, then the last size only.
        let which = if n < 90 { (n / 3) as usize % sizes.len() } else { sizes.len() - 1 };
        let Produced::Frame(frame) = producers[which].next_frame(&control, Instant::now()).expect("frame") else {
            panic!("the pattern ended");
        };
        let start = Instant::now();
        let packet = encoder.encode(&frame, 6_000_000, 1, n == 0).expect("encode");
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        out.write_all(&packet.data).unwrap();
        writeln!(
            csv,
            "{n},{:.1},{}x{},{},{},{ms:.3}",
            start.saturating_duration_since(began).as_secs_f64() * 1000.0,
            frame.width,
            frame.height,
            packet.data.len(),
            u8::from(packet.key)
        )
        .unwrap();
    }
    eprintln!("240 frames in {:.2} s", began.elapsed().as_secs_f64());
}
