// The engine is a separate process now: `pylon-media-host`, driven over its control protocol
// (native/media-engine/PROTOCOL.md). This starts it, writes requests and records what it says.

use std::{
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
};

/// The sharer's preview requests the probes send (M6 preview step 1, R8): PROBE_PREVIEW, a comma
/// separated list of `<seconds after open>@<fps>:<width>x<height>`, or `<fps>:<width>x<height>`
/// for one request right after `open`. Unset: no preview is asked for. Anything unreadable ends
/// the probe.
pub fn preview_schedule() -> Option<Vec<(Duration, Value)>> {
    let text = std::env::var("PROBE_PREVIEW").ok()?;
    let parse = |entry: &str| -> Option<(Duration, Value)> {
        let (at, rest) = entry.split_once('@').unwrap_or(("0", entry));
        let (fps, size) = rest.split_once(':')?;
        let (width, height) = size.split_once('x')?;
        let at = Duration::from_secs_f64(at.trim().parse().ok()?);
        let request = json!({ "preview": { "fps": fps.trim().parse::<u32>().ok()?, "max_width": width.trim().parse::<u32>().ok()?, "max_height": height.trim().parse::<u32>().ok()? } });
        Some((at, request))
    };
    let schedule: Option<Vec<_>> = text.split(',').filter(|e| !e.trim().is_empty()).map(parse).collect();
    match schedule {
        Some(schedule) if !schedule.is_empty() => Some(schedule),
        _ => {
            eprintln!("PROBE_PREVIEW={text}: expected <s>@<fps>:<w>x<h>[,...]");
            std::process::exit(2);
        }
    }
}

/// One `preview` message: when it came (sidecar clock), its size and its JPEG.
pub struct PreviewSeen {
    pub t_ms: f64,
    pub width: u64,
    pub height: u64,
    pub jpeg: Vec<u8>,
}

/// Standard base64 with padding, as the sidecar writes it.
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let bytes = text.as_bytes();
    if bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let pad = chunk.iter().rev().take_while(|&&c| c == b'=').count();
        let mut n = 0u32;
        for &c in &chunk[..4 - pad] {
            n = (n << 6) | value(c)?;
        }
        n <<= 6 * pad as u32;
        let three = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        out.extend_from_slice(&three[..3 - pad]);
    }
    Some(out)
}

/// Writes every preview picture into `dir` (`preview-<n>.jpg` and `previews.csv`) and returns a
/// summary: how many came, at what rate after the first, at which sizes.
pub fn write_previews(log: &SidecarLog, dir: Option<&std::path::Path>) -> String {
    use std::fmt::Write as _;
    let previews = &log.previews;
    let mut summary = String::new();
    let _ = write!(summary, "preview: {} pictures", previews.len());
    if let (Some(first), Some(last)) = (previews.first(), previews.last())
        && previews.len() > 1
    {
        let seconds = (last.t_ms - first.t_ms) / 1000.0;
        let _ = write!(summary, ", {:.2} a second from the first to the last ({:.1} s)", (previews.len() - 1) as f64 / seconds, seconds);
        let mut sizes: Vec<(u64, u64)> = previews.iter().map(|p| (p.width, p.height)).collect();
        sizes.dedup();
        let _ = write!(summary, ", sizes in order {sizes:?}");
        let gaps: Vec<f64> = previews.windows(2).map(|w| w[1].t_ms - w[0].t_ms).collect();
        let _ = write!(
            summary,
            ", gaps {:.0} to {:.0} ms",
            gaps.iter().copied().fold(f64::INFINITY, f64::min),
            gaps.iter().copied().fold(0.0, f64::max)
        );
    }
    let bad = previews.iter().filter(|p| !p.jpeg.starts_with(&[0xff, 0xd8]) || !p.jpeg.ends_with(&[0xff, 0xd9])).count();
    let _ = write!(summary, ", {bad} not JPEG");
    if let Some(dir) = dir {
        let _ = std::fs::create_dir_all(dir);
        let mut csv = String::from("n,t_ms,width,height,bytes\n");
        for (n, preview) in previews.iter().enumerate() {
            let _ = std::fs::write(dir.join(format!("preview-{n:04}.jpg")), &preview.jpeg);
            let _ = writeln!(csv, "{n},{:.3},{},{},{}", preview.t_ms, preview.width, preview.height, preview.jpeg.len());
        }
        let _ = std::fs::write(dir.join("previews.csv"), csv);
        let _ = write!(summary, ", written to {}", dir.display());
    }
    summary
}

/// The video codec the probes ask the sidecar for: PROBE_CODEC, `H264` (the default) or `AV1`
/// (AV1 step 2, Q11). Anything else ends the probe.
pub fn codec() -> String {
    let codec = std::env::var("PROBE_CODEC").unwrap_or_else(|_| "H264".into());
    if codec != "H264" && codec != "AV1" {
        eprintln!("PROBE_CODEC={codec}: expected H264 or AV1");
        std::process::exit(2);
    }
    codec
}

/// Everything the sidecar said, in the order it came.
#[derive(Default)]
pub struct SidecarLog {
    pub hello: Option<Value>,
    /// The screen capture: `capture_ready`, whether it was cancelled, and each `capture_changed`.
    pub capture_ready: Option<Value>,
    pub capture_cancelled: bool,
    pub capture_changed: Vec<Value>,
    pub opened: Option<Value>,
    /// `t_ms` of `opened` and `connected`.
    pub opened_ms: Option<f64>,
    pub connected_ms: Option<f64>,
    pub ice_states: Vec<(f64, String)>,
    pub key_frame_requests: Vec<(f64, String)>,
    pub stats: Vec<Value>,
    pub errors: Vec<Value>,
    /// Every `preview`, with its JPEG decoded.
    pub previews: Vec<PreviewSeen>,
    pub closed: Option<Value>,
    /// Lines on stdout that were not JSON. The protocol allows none.
    pub not_json: Vec<String>,
}

impl SidecarLog {
    pub fn last_stats(&self) -> Option<&Value> {
        self.stats.last()
    }

    /// A counter from the latest statistics, 0 before there are any.
    pub fn stat(&self, name: &str) -> u64 {
        self.last_stats().and_then(|s| s[name].as_u64()).unwrap_or(0)
    }

    pub fn fatal(&self) -> Option<&Value> {
        self.errors.iter().find(|e| e["fatal"] == true)
    }
}

pub struct Sidecar {
    child: Child,
    /// Shared with the task that sends the preview's requests.
    stdin: Arc<tokio::sync::Mutex<Option<ChildStdin>>>,
    pub log: Arc<Mutex<SidecarLog>>,
}

/// Writes one request line to `stdin`.
async fn write_line(stdin: &tokio::sync::Mutex<Option<ChildStdin>>, message: &Value) -> Result<(), String> {
    let mut stdin = stdin.lock().await;
    let stdin = stdin.as_mut().ok_or("stdin is closed")?;
    let line = format!("{message}\n");
    stdin.write_all(line.as_bytes()).await.map_err(|e| format!("write to sidecar: {e}"))?;
    stdin.flush().await.map_err(|e| format!("write to sidecar: {e}"))
}

/// `PYLON_MEDIA_HOST`, else `pylon-media-host` beside this executable.
pub fn path() -> PathBuf {
    if let Some(path) = std::env::var_os("PYLON_MEDIA_HOST") {
        return PathBuf::from(path);
    }
    let exe = std::env::current_exe().unwrap_or_default();
    exe.with_file_name("pylon-media-host")
}

impl Sidecar {
    /// Starts the sidecar with `flags`. Its stderr goes where this process's goes.
    pub fn start(flags: &[&str]) -> Result<Sidecar, String> {
        let path = path();
        let mut child = Command::new(&path)
            .args(flags)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("cannot start {}: {e}", path.display()))?;
        eprintln!("sidecar: {} {} (pid {:?})", path.display(), flags.join(" "), child.id());
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let log = Arc::new(Mutex::new(SidecarLog::default()));
        {
            let log = log.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    record(&log, &line);
                }
            });
        }
        Ok(Sidecar { child, stdin: Arc::new(tokio::sync::Mutex::new(stdin)), log })
    }

    pub async fn send(&mut self, message: Value) -> Result<(), String> {
        write_line(&self.stdin, &message).await
    }

    /// Sends PROBE_PREVIEW's requests on their schedule, from now (R8). Returns whether any are.
    pub fn start_preview_schedule(&self) -> bool {
        let Some(schedule) = preview_schedule() else {
            return false;
        };
        let stdin = self.stdin.clone();
        tokio::spawn(async move {
            let began = Instant::now();
            for (at, request) in schedule {
                tokio::time::sleep_until((began + at).into()).await;
                eprintln!("probe: {request} at {:.1} s after open", began.elapsed().as_secs_f64());
                if let Err(error) = write_line(&stdin, &request).await {
                    eprintln!("probe: preview request not sent: {error}");
                    return;
                }
            }
        });
        true
    }

    /// Waits until `ready` holds for the log, or a fatal error, or the deadline.
    pub async fn wait_for<T>(&self, timeout: Duration, ready: impl Fn(&SidecarLog) -> Option<T>) -> Result<T, String> {
        let deadline = Instant::now() + timeout;
        loop {
            {
                let log = self.log.lock().unwrap();
                if let Some(value) = ready(&log) {
                    return Ok(value);
                }
                if let Some(error) = log.fatal() {
                    return Err(format!("sidecar: {error}"));
                }
                if log.closed.is_some() {
                    return Err(format!("sidecar closed: {:?}", log.closed));
                }
            }
            if Instant::now() > deadline {
                return Err(format!("sidecar: nothing within {timeout:?}"));
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// `hello`, then `open`. Returns `opened`.
    pub async fn hello_and_open(&mut self, open: Value) -> Result<Value, String> {
        self.send(json!({ "hello": { "protocol": 1 } })).await?;
        let hello = self.wait_for(Duration::from_secs(5), |log| log.hello.clone()).await?;
        eprintln!("sidecar: {hello}");
        self.send(json!({ "open": open })).await?;
        self.wait_for(Duration::from_secs(5), |log| log.opened.clone()).await
    }

    /// `hello`, then `capture` of the screen, waiting up to `timeout` for the person in the
    /// portal's dialog. `target` (Windows, M7.5 C15) names what to capture, as the protocol's
    /// JSON. Returns `capture_ready`.
    pub async fn hello_and_capture(
        &mut self,
        restore_token: Option<String>,
        max_fps: Option<u32>,
        target: Option<Value>,
        timeout: Duration,
    ) -> Result<Value, String> {
        self.send(json!({ "hello": { "protocol": 1 } })).await?;
        let hello = self.wait_for(Duration::from_secs(5), |log| log.hello.clone()).await?;
        eprintln!("sidecar: {hello}");
        let mut screen = json!({ "restore_token": restore_token, "max_fps": max_fps });
        if let Some(target) = target {
            screen["target"] = target;
        }
        self.send(json!({ "capture": { "screen": screen } })).await?;
        let ready = self
            .wait_for(timeout, |log| {
                if log.capture_cancelled {
                    return Some(Err("capture_cancelled".to_string()));
                }
                log.capture_ready.clone().map(Ok)
            })
            .await??;
        let mut shown = ready.clone();
        shown["restore_token"] = json!(ready["restore_token"].is_string());
        eprintln!("sidecar: capture_ready {shown}");
        Ok(ready)
    }

    /// `open` after `hello_and_capture`. Returns `opened`.
    pub async fn open(&mut self, open: Value) -> Result<Value, String> {
        self.send(json!({ "open": open })).await?;
        self.wait_for(Duration::from_secs(5), |log| log.opened.clone()).await
    }

    /// Closes stdin without a `close` and waits up to `timeout` for the exit status.
    pub async fn close_stdin(&mut self, timeout: Duration) -> (Duration, Option<i32>) {
        let began = Instant::now();
        *self.stdin.lock().await = None;
        let status = tokio::time::timeout(timeout, self.child.wait()).await;
        (began.elapsed(), status.ok().and_then(Result::ok).and_then(|s| s.code()))
    }

    /// `close`, then waits for the exit. Kills it if it takes longer than `timeout`.
    pub async fn close(&mut self, timeout: Duration) -> Option<i32> {
        let _ = self.send(json!({ "close": {} })).await;
        *self.stdin.lock().await = None;
        match tokio::time::timeout(timeout, self.child.wait()).await {
            Ok(status) => status.ok().and_then(|s| s.code()),
            Err(_) => {
                eprintln!("sidecar: no exit within {timeout:?}, killing it");
                let _ = self.child.kill().await;
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_as_the_sidecar_writes_it() {
        assert_eq!(base64_decode("/9j/2Q=="), Some(vec![0xff, 0xd8, 0xff, 0xd9]));
        assert_eq!(base64_decode("TWFu"), Some(b"Man".to_vec()));
        assert_eq!(base64_decode("TWE="), Some(b"Ma".to_vec()));
        assert_eq!(base64_decode(""), Some(vec![]));
        assert_eq!(base64_decode("TWF"), None);
        assert_eq!(base64_decode("T!Fu"), None);
    }
}

fn record(log: &Mutex<SidecarLog>, line: &str) {
    let mut log = log.lock().unwrap();
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        eprintln!("sidecar: not JSON on stdout: {line}");
        log.not_json.push(line.to_owned());
        return;
    };
    let Some((name, body)) = message.as_object().and_then(|o| o.iter().next()) else {
        log.not_json.push(line.to_owned());
        return;
    };
    let t_ms = body["t_ms"].as_f64().unwrap_or(f64::NAN);
    match name.as_str() {
        "hello" => log.hello = Some(body.clone()),
        "opened" => {
            log.opened = Some(body.clone());
            log.opened_ms = Some(t_ms);
        }
        "connected" => log.connected_ms = Some(t_ms),
        "ice_state" => log.ice_states.push((t_ms, body["state"].as_str().unwrap_or("?").to_owned())),
        "key_frame_request" => log.key_frame_requests.push((t_ms, body["kind"].as_str().unwrap_or("?").to_owned())),
        "stats" => log.stats.push(body.clone()),
        "error" => {
            eprintln!("sidecar error: {body}");
            log.errors.push(body.clone());
        }
        "closed" => log.closed = Some(body.clone()),
        "capture_ready" => log.capture_ready = Some(body.clone()),
        "capture_cancelled" => log.capture_cancelled = true,
        "capture_changed" => {
            eprintln!("sidecar: capture_changed {body}");
            log.capture_changed.push(body.clone());
        }
        // Counted and kept, never printed: it is the picture.
        "preview" => {
            let jpeg = body["jpeg"].as_str().and_then(base64_decode).unwrap_or_default();
            log.previews.push(PreviewSeen {
                t_ms,
                width: body["width"].as_u64().unwrap_or(0),
                height: body["height"].as_u64().unwrap_or(0),
                jpeg,
            });
        }
        _ => eprintln!("sidecar: unexpected {message}"),
    }
}
