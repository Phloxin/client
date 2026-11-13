// A UDP relay between the sidecar and the node, for probe 3
// (.plans/native-media-engine-m5a-encoder.md, D15). The sidecar is given the relay's address as
// the node's candidate. Its front, the side the sidecar sends to, listens on `PROBE_LISTEN_IP`
// (default 127.0.0.1) as the node does, so a sidecar on another machine reaches it (M7 plan,
// D19). Its back side stays on loopback. Toward the node the relay applies a rate limit (a token
// bucket whose queue drops what would wait longer than 300 ms), a fixed delay and random loss.
// Toward the sidecar it forwards at once.

use std::{
    collections::BinaryHeap,
    cmp::Reverse,
    net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

/// A packet that would wait longer than this for the rate limit is dropped.
const MAX_QUEUE_DELAY: Duration = Duration::from_millis(300);
/// The token bucket holds this much of the rate, so short bursts pass at once.
/// RELAY_BUCKET_MS changes it for diagnostic runs only.
fn bucket() -> Duration {
    Duration::from_millis(crate::env("RELAY_BUCKET_MS", 10))
}

/// What the link does toward the node.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Limits {
    /// Bits per second, `None` for no limit.
    pub rate_bps: Option<u64>,
    pub delay: Duration,
    /// Share of packets lost, 0 to 1.
    pub loss: f64,
}

/// Totals since the relay started.
#[derive(Clone, Copy, Debug, Default)]
pub struct Counters {
    /// From the sidecar: packets and UDP payload bytes, before loss and the limit.
    pub in_packets: u64,
    pub in_bytes: u64,
    /// Forwarded to the node.
    pub out_packets: u64,
    pub out_bytes: u64,
    pub dropped_over_limit: u64,
    pub dropped_loss: u64,
    /// From the node to the sidecar.
    pub back_packets: u64,
    /// Bytes waiting for the rate limit now, and how long the last of them waits.
    pub queued_bytes: u64,
    pub queued_ms: f64,
    /// The highest `queued_ms` since `take_queue_max` was last called.
    pub queued_ms_max: f64,
}

struct Shared {
    limits: Limits,
    counters: Counters,
}

pub struct Relay {
    /// What the sidecar is told the node is.
    pub address: SocketAddr,
    shared: Arc<Mutex<Shared>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

/// A small random number generator, so loss is the same from run to run.
struct Random(u64);

impl Random {
    fn next_f64(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
}

struct Waiting {
    due: Instant,
    order: u64,
    data: Vec<u8>,
}

impl PartialEq for Waiting {
    fn eq(&self, other: &Self) -> bool {
        (self.due, self.order) == (other.due, other.order)
    }
}
impl Eq for Waiting {}
impl PartialOrd for Waiting {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Waiting {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        (self.due, self.order).cmp(&(other.due, other.order))
    }
}

impl Relay {
    /// Starts relaying toward `node`.
    pub fn start(node: SocketAddr) -> std::io::Result<Relay> {
        let front = UdpSocket::bind((crate::env("PROBE_LISTEN_IP", IpAddr::V4(Ipv4Addr::LOCALHOST)), 0))?;
        let back = UdpSocket::bind("127.0.0.1:0")?;
        front.set_nonblocking(true)?;
        back.set_nonblocking(true)?;
        let address = front.local_addr()?;
        let shared = Arc::new(Mutex::new(Shared { limits: Limits::default(), counters: Counters::default() }));
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let (shared, stop) = (shared.clone(), stop.clone());
            std::thread::Builder::new()
                .name("relay".into())
                .spawn(move || run(front, back, node, shared, stop))?
        };
        Ok(Relay { address, shared, stop, thread: Some(thread) })
    }

    pub fn set_limits(&self, limits: Limits) {
        self.shared.lock().unwrap().limits = limits;
    }

    /// The counters, with the highest queue reading since the last call.
    pub fn sample(&self) -> Counters {
        let mut shared = self.shared.lock().unwrap();
        let counters = shared.counters;
        shared.counters.queued_ms_max = shared.counters.queued_ms;
        counters
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run(front: UdpSocket, back: UdpSocket, node: SocketAddr, shared: Arc<Mutex<Shared>>, stop: Arc<AtomicBool>) {
    let mut buffer = [0u8; 2048];
    let mut sidecar: Option<SocketAddr> = None;
    let mut random = Random(0x5eed_1234_abcd_0001);
    // When the rate limit's queue is empty again, as a time.
    let mut free_at = Instant::now();
    // What is waiting for the limit, in bytes, with each packet's time of leaving the queue.
    let mut limited: std::collections::VecDeque<(Instant, usize)> = Default::default();
    let mut waiting: BinaryHeap<Reverse<Waiting>> = BinaryHeap::new();
    let mut order = 0u64;
    let bucket = bucket();

    while !stop.load(Ordering::Relaxed) {
        let mut busy = false;
        let now = Instant::now();

        // From the sidecar toward the node.
        while let Ok((len, from)) = front.recv_from(&mut buffer) {
            busy = true;
            sidecar = Some(from);
            let mut s = shared.lock().unwrap();
            let limits = s.limits;
            s.counters.in_packets += 1;
            s.counters.in_bytes += len as u64;
            if limits.loss > 0.0 && random.next_f64() < limits.loss {
                s.counters.dropped_loss += 1;
                continue;
            }
            let leaves = match limits.rate_bps {
                None => now,
                Some(rate) => {
                    // Unused time up to the bucket is credit, so a burst that size passes at once.
                    let base = free_at.max(now.checked_sub(bucket).unwrap_or(now));
                    let finish = base + Duration::from_secs_f64(len as f64 * 8.0 / rate as f64);
                    let leaves = finish.max(now);
                    if leaves.saturating_duration_since(now) > MAX_QUEUE_DELAY {
                        s.counters.dropped_over_limit += 1;
                        continue;
                    }
                    free_at = finish;
                    limited.push_back((leaves, len));
                    leaves
                }
            };
            order += 1;
            waiting.push(Reverse(Waiting { due: leaves + limits.delay, order, data: buffer[..len].to_vec() }));
        }

        // Due packets out to the node.
        while let Some(Reverse(next)) = waiting.peek() {
            if next.due > now {
                break;
            }
            let Reverse(next) = waiting.pop().unwrap();
            let _ = back.send_to(&next.data, node);
            let mut s = shared.lock().unwrap();
            s.counters.out_packets += 1;
            s.counters.out_bytes += next.data.len() as u64;
            busy = true;
        }

        // From the node back to the sidecar, at once.
        while let Ok((len, _)) = back.recv_from(&mut buffer) {
            busy = true;
            if let Some(to) = sidecar {
                let _ = front.send_to(&buffer[..len], to);
            }
            shared.lock().unwrap().counters.back_packets += 1;
        }

        while limited.front().is_some_and(|(leaves, _)| *leaves <= now) {
            limited.pop_front();
        }
        {
            let mut s = shared.lock().unwrap();
            s.counters.queued_bytes = limited.iter().map(|(_, len)| *len as u64).sum();
            s.counters.queued_ms = free_at.saturating_duration_since(now).as_secs_f64() * 1000.0;
            s.counters.queued_ms_max = s.counters.queued_ms_max.max(s.counters.queued_ms);
        }

        if !busy {
            std::thread::sleep(Duration::from_micros(100));
        }
    }
}
