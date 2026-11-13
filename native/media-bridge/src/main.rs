// A stdin and stdout bridge over a local TCP port (.plans/native-media-engine-m7-5-windows-capture.md,
// C14). ssh on the Windows laptop lands in session 0, which has no desktop, so a sidecar that
// captures the screen must run in the desktop session. There `serve` starts it with its stdin and
// stdout joined to one connection on 127.0.0.1, and from the ssh session `connect` joins its own
// stdin and stdout to that port. The probe's wrapper script runs `connect` over ssh as it ran the
// sidecar before.
//
//   media-bridge serve <port> <wait_s> <program> [args...]
//     Listens on 127.0.0.1:<port>, takes one connection within <wait_s> seconds, starts <program>
//     with its stdin and stdout joined to it (its stderr is this process's) and exits with the
//     program's exit status once the program has ended.
//   media-bridge connect <port> [args...]
//     Joins stdin and stdout to 127.0.0.1:<port> and exits when the far side closes. Arguments
//     after the port are ignored (the probe passes the sidecar's flags there, `serve` was given
//     them already) and named on stderr.

use std::{
    io::{Read, Write},
    net::{Ipv4Addr, Shutdown, TcpListener, TcpStream},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

/// Copies until the end of `from`, flushing every piece.
fn copy(mut from: impl Read, mut to: impl Write) -> std::io::Result<u64> {
    let mut buffer = [0u8; 65536];
    let mut total = 0;
    loop {
        let n = match from.read(&mut buffer) {
            Ok(0) => return Ok(total),
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        to.write_all(&buffer[..n])?;
        to.flush()?;
        total += n as u64;
    }
}

fn serve(port: u16, wait: Duration, program: &str, args: &[String]) -> i32 {
    let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, port)) {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("media-bridge: bind 127.0.0.1:{port}: {e}");
            return 1;
        }
    };
    if let Err(e) = listener.set_nonblocking(true) {
        eprintln!("media-bridge: {e}");
        return 1;
    }
    eprintln!("media-bridge: listening on 127.0.0.1:{port} for {} s", wait.as_secs());
    let deadline = Instant::now() + wait;
    let stream = loop {
        match listener.accept() {
            Ok((stream, peer)) => {
                eprintln!("media-bridge: connection from {peer}");
                break stream;
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    eprintln!("media-bridge: no connection within {} s", wait.as_secs());
                    return 3;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                eprintln!("media-bridge: accept: {e}");
                return 1;
            }
        }
    };
    drop(listener);
    let reader = match stream.set_nonblocking(false).and_then(|()| stream.set_nodelay(true)).and_then(|()| stream.try_clone()) {
        Ok(reader) => reader,
        Err(e) => {
            eprintln!("media-bridge: {e}");
            return 1;
        }
    };
    let mut child = match Command::new(program).args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn() {
        Ok(child) => child,
        Err(e) => {
            eprintln!("media-bridge: cannot start {program}: {e}");
            return 1;
        }
    };
    eprintln!("media-bridge: started {program} {} (pid {})", args.join(" "), child.id());
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        eprintln!("media-bridge: no pipes");
        let _ = child.kill();
        return 1;
    };
    // The connection into the program's stdin. Its end (or an error) closes the stdin, which the
    // sidecar takes as the host gone.
    std::thread::spawn(move || {
        let copied = copy(reader, stdin);
        eprintln!("media-bridge: input ended: {copied:?}");
    });
    let copied = copy(stdout, &stream);
    eprintln!("media-bridge: output ended: {copied:?}");
    let _ = stream.shutdown(Shutdown::Write);
    let code = match child.wait() {
        Ok(status) => status.code().unwrap_or(1),
        Err(e) => {
            eprintln!("media-bridge: wait: {e}");
            1
        }
    };
    eprintln!("media-bridge: {program} exited with {code}");
    // The input thread may still wait on the connection. The process's end closes it.
    code
}

fn connect(port: u16) -> i32 {
    // `serve` may still be starting.
    let deadline = Instant::now() + Duration::from_secs(10);
    let stream = loop {
        match TcpStream::connect((Ipv4Addr::LOCALHOST, port)) {
            Ok(stream) => break stream,
            Err(e) if Instant::now() < deadline => {
                let _ = e;
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                eprintln!("media-bridge: connect 127.0.0.1:{port}: {e}");
                return 1;
            }
        }
    };
    let writer = match stream.set_nodelay(true).and_then(|()| stream.try_clone()) {
        Ok(writer) => writer,
        Err(e) => {
            eprintln!("media-bridge: {e}");
            return 1;
        }
    };
    std::thread::spawn(move || {
        let _ = copy(std::io::stdin().lock(), &writer);
        // The end of input goes on as the end of the connection's sending half.
        let _ = writer.shutdown(Shutdown::Write);
    });
    let copied = copy(&stream, std::io::stdout().lock());
    if let Err(e) = copied {
        eprintln!("media-bridge: {e}");
    }
    0
}

fn usage() -> i32 {
    eprintln!("usage: media-bridge serve <port> <wait_s> <program> [args...] | media-bridge connect <port> [args...]");
    2
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let port = |text: Option<&String>| text.and_then(|t| t.parse::<u16>().ok());
    let code = match args.first().map(String::as_str) {
        Some("serve") => match (port(args.get(1)), args.get(2).and_then(|t| t.parse::<u64>().ok()), args.get(3)) {
            (Some(port), Some(wait), Some(program)) => serve(port, Duration::from_secs(wait), program, &args[4..]),
            _ => usage(),
        },
        Some("connect") => match port(args.get(1)) {
            Some(port) => {
                if args.len() > 2 {
                    eprintln!("media-bridge: ignored {:?}", &args[2..]);
                }
                connect(port)
            }
            None => usage(),
        },
        _ => usage(),
    };
    std::process::exit(code);
}
