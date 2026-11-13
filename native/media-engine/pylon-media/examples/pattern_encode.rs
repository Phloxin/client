// The pattern producer and the VA-API encoder without the transport, for measuring them alone:
//   cargo run --release --features encode --example pattern_encode -- \
//     width=1920 height=1080 fps=60 frames=600 bitrate=6000000 still=0 out=/tmp/p.h264 csv=/tmp/p.csv \
//     [keys=120,121] [rates=300:2000000] [filler=1] [kind=screen|stress] [divs=300:3]
// Writes the Annex-B stream and one CSV line per frame: frame,bytes,key,encode_ms.

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
    let num = |k: &str, d: &str| get(k, d).parse::<u64>().expect(k);
    let (width, height, fps) = (num("width", "1920") as u32, num("height", "1080") as u32, num("fps", "60") as u32);
    let frames = num("frames", "600");
    let mut bitrate = num("bitrate", "6000000");
    let still = get("still", "0") == "1";
    let keys: Vec<u64> = get("keys", "").split(',').filter_map(|s| s.parse().ok()).collect();
    let divs: HashMap<u64, u32> = get("divs", "")
        .split(',')
        .filter_map(|s| s.split_once(':'))
        .map(|(f, d)| (f.parse().unwrap(), d.parse().unwrap()))
        .collect();
    let mut divisor = 1u32;
    let rates: HashMap<u64, u64> = get("rates", "")
        .split(',')
        .filter_map(|s| s.split_once(':'))
        .map(|(f, b)| (f.parse().unwrap(), b.parse().unwrap()))
        .collect();

    let mut producer = PatternProducer::new(width, height, fps, still, if get("kind", "screen") == "stress" { PatternKind::Stress } else { PatternKind::Screen }).expect("pattern");
    let mut encoder = VaapiEncoder::new(EncoderConfig { width, height, fps, start_bitrate: bitrate, filler: get("filler", "0") == "1" }).expect("encoder");
    let control = SourceControl::default();
    let mut out = std::fs::File::create(get("out", "/tmp/pattern.h264")).expect("out");
    let mut csv = std::fs::File::create(get("csv", "/tmp/pattern.csv")).expect("csv");
    writeln!(csv, "frame,bytes,key,encode_ms").unwrap();
    let began = Instant::now();
    for n in 0..frames {
        if let Some(&b) = rates.get(&n) {
            bitrate = b;
        }
        if let Some(&d) = divs.get(&n) {
            divisor = d;
        }
        let Produced::Frame(frame) = producer.next_frame(&control, Instant::now()).expect("frame") else {
            panic!("the pattern ended");
        };
        if n % divisor as u64 != 0 {
            continue;
        }
        let start = Instant::now();
        let packet = encoder.encode(&frame, bitrate, divisor, n == 0 || keys.contains(&n)).expect("encode");
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        out.write_all(&packet.data).unwrap();
        writeln!(csv, "{n},{},{},{ms:.3}", packet.data.len(), u8::from(packet.key)).unwrap();
    }
    eprintln!("{frames} frames in {:.2} s", began.elapsed().as_secs_f64());
}
