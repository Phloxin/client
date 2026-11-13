// Probes for the native media engine (.plans/native-media-engine.md, section 7), run through the
// `pylon-media-host` sidecar (.plans/native-media-engine-m2-engine.md, D19 to D21).
//
//   media-probe                  probe 1: the engine against the node's transports, seven checks
//   media-probe viewer ...       probe 2: the sending half for a Chromium viewer
//                                (.plans/native-media-engine-probe2.md, driven by viewer/run.mjs)
//   media-probe probe3 ...       probe 3: the hardware encoder against a limited link
//                                (.plans/native-media-engine-m5a-encoder.md, D15 to D17)
//   media-probe chrome ...       probe 3's Chromium baseline (D26), driven by viewer/sender.mjs
//
// The sidecar is PYLON_MEDIA_HOST, else `pylon-media-host` beside this executable.
// PROBE_LISTEN_IP (default 127.0.0.1) is where the node's WebRtcServer and probe 3's relay listen.

mod chrome;
mod node;
mod probe1;
mod probe2;
mod probe3;
mod relay;
mod sidecar;

/// An environment variable parsed as `T`, or `default`.
pub fn env<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        None => probe1::run().await,
        Some("viewer") => probe2::run(&args[1..]).await,
        Some("probe3") => probe3::run(&args[1..]).await,
        Some("chrome") => chrome::run(&args[1..]).await,
        Some(other) => {
            eprintln!("unknown mode {other}, expected no arguments (probe 1), `viewer` or `probe3`");
            2
        }
    };
    std::process::exit(code);
}
