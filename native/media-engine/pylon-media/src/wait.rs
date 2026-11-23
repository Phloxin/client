// The I/O loop's wait between polls (smooth B4). Off Windows it is the sleep the loop always had.
// On Windows a sleep of 200 microseconds took about 0.87 ms, and the pacer fell behind
// (.plans/native-media-engine-m7-7a-limited-link-cure.md, cause B).
//
// PYLON_MEDIA_WAIT chooses the Windows way, a switch for measurement and support:
// - `sleep`: the thread sleeps until the deadline, as before.
// - `event`: the socket's read event (`WSAEventSelect`) and a high resolution waitable timer in
//   one `WaitForMultipleObjects`: a packet from the node wakes the loop at once, the timer at the
//   deadline.
// - `spin`: `event` for a wait of 1 ms or more, and for a shorter one a spin that looks at the
//   socket's read event until the deadline.
// The default is `DEFAULT` below (smooth B4.5).

use std::{net::UdpSocket, time::Instant};

/// Waits until `deadline`, or on Windows (`event`, `spin`) until a packet comes on `socket` if
/// that is sooner.
pub(crate) fn until(socket: &UdpSocket, deadline: Instant) {
    #[cfg(all(target_os = "windows", feature = "encode"))]
    imp::until(socket, deadline);
    #[cfg(not(all(target_os = "windows", feature = "encode")))]
    {
        let _ = socket;
        std::thread::sleep(deadline.saturating_duration_since(Instant::now()));
    }
}

#[cfg(all(target_os = "windows", feature = "encode"))]
mod imp {
    use std::{
        cell::RefCell,
        net::UdpSocket,
        os::windows::io::AsRawSocket,
        sync::OnceLock,
        time::{Duration, Instant},
    };

    use ::windows::Win32::{
        Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0},
        Networking::WinSock::{FD_READ, SOCKET, WSACloseEvent, WSACreateEvent, WSAEVENT, WSAEnumNetworkEvents, WSAEventSelect, WSANETWORKEVENTS},
        System::Threading::{
            CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, CreateWaitableTimerExW, SetWaitableTimer, TIMER_ALL_ACCESS, WaitForMultipleObjects,
            WaitForSingleObject,
        },
    };

    /// The ways to wait.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Way {
        Sleep,
        Event,
        Spin,
    }

    /// The way when the variable is not set (smooth B4.5): `event` cost no more CPU than `sleep`
    /// (35.9 against 36.8 % of one core, 3 runs each), kept the send queue under 50 ms as both
    /// did, and was not worse in probe 3; `spin` cost 1.3 cores.
    const DEFAULT: Way = Way::Event;
    /// Below this `spin` spins, from here on it waits as `event` does.
    const SPIN_BELOW: Duration = Duration::from_millis(1);

    fn way() -> Way {
        static WAY: OnceLock<Way> = OnceLock::new();
        *WAY.get_or_init(|| {
            let way = match std::env::var("PYLON_MEDIA_WAIT").as_deref() {
                Err(_) => DEFAULT,
                Ok("sleep") => Way::Sleep,
                Ok("event") => Way::Event,
                Ok("spin") => Way::Spin,
                Ok(other) => {
                    tracing::warn!(value = other, default = ?DEFAULT, "PYLON_MEDIA_WAIT is sleep, event or spin");
                    DEFAULT
                }
            };
            tracing::info!(?way, "I/O loop wait");
            way
        })
    }

    /// The socket's read event and the timer, made on the loop's thread for its socket.
    struct Waiter {
        socket: SOCKET,
        event: WSAEVENT,
        timer: HANDLE,
    }

    impl Waiter {
        fn new(socket: SOCKET) -> Result<Waiter, String> {
            // SAFETY: plain calls; what they make is owned by the waiter, which closes it.
            unsafe {
                let event = WSACreateEvent().map_err(|e| format!("WSACreateEvent: {e}"))?;
                let timer = match CreateWaitableTimerExW(None, None, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS.0) {
                    Ok(timer) => timer,
                    Err(error) => {
                        let _ = WSACloseEvent(event);
                        return Err(format!("CreateWaitableTimerExW: {error}"));
                    }
                };
                let waiter = Waiter { socket, event, timer };
                // The socket stays non-blocking (it was already).
                if WSAEventSelect(socket, Some(event), FD_READ as i32) != 0 {
                    return Err(format!("WSAEventSelect: {}", ::windows::core::Error::from_thread()));
                }
                Ok(waiter)
            }
        }

        fn event(&self) -> HANDLE {
            HANDLE(self.event.0 as *mut _)
        }

        /// The read event is set again only by a new packet (it is reset here, and every read
        /// re-enables it).
        fn reset(&self) {
            let mut events = WSANETWORKEVENTS::default();
            // SAFETY: the socket and event this waiter selected, an owned out value.
            unsafe { WSAEnumNetworkEvents(self.socket, self.event, &mut events) };
        }

        /// Waits for a packet or `wait`.
        fn wait(&self, wait: Duration) {
            // Relative, in 100 ns units.
            let due = -((wait.as_nanos() / 100).max(1) as i64);
            // SAFETY: the waiter's own handles, an owned due time.
            unsafe {
                if SetWaitableTimer(self.timer, &due, 0, None, None, false).is_err() {
                    std::thread::sleep(wait);
                    return;
                }
                // A safety bound in case the timer never comes.
                let bound = wait.as_millis() as u32 + 2;
                if WaitForMultipleObjects(&[self.event(), self.timer], false, bound) == WAIT_OBJECT_0 {
                    self.reset();
                }
            }
        }

        /// Spins until a packet or `deadline`.
        fn spin(&self, deadline: Instant) {
            while Instant::now() < deadline {
                // SAFETY: the waiter's own event, looked at without waiting.
                if unsafe { WaitForSingleObject(self.event(), 0) } == WAIT_OBJECT_0 {
                    self.reset();
                    return;
                }
                std::hint::spin_loop();
            }
        }
    }

    impl Drop for Waiter {
        fn drop(&mut self) {
            // SAFETY: the waiter's own handles. The socket's selection is left: it is gone or goes
            // with its socket, and its handle may already be another socket's.
            unsafe {
                let _ = CloseHandle(self.timer);
                let _ = WSACloseEvent(self.event);
            }
        }
    }

    thread_local! {
        /// The loop thread's waiter, `Err` once one could not be made (then it sleeps).
        static WAITER: RefCell<Option<Result<Waiter, ()>>> = const { RefCell::new(None) };
    }

    pub(super) fn until(socket: &UdpSocket, deadline: Instant) {
        let way = way();
        let wait = deadline.saturating_duration_since(Instant::now());
        if way == Way::Sleep || wait.is_zero() {
            std::thread::sleep(wait);
            return;
        }
        let raw = SOCKET(socket.as_raw_socket() as usize);
        WAITER.with_borrow_mut(|waiter| {
            if !matches!(waiter, Some(Ok(w)) if w.socket == raw) && !matches!(waiter, Some(Err(()))) {
                *waiter = Some(Waiter::new(raw).map_err(|error| tracing::warn!(%error, "the I/O loop sleeps instead")));
            }
            match waiter {
                Some(Ok(waiter)) if way == Way::Spin && wait < SPIN_BELOW => waiter.spin(deadline),
                Some(Ok(waiter)) => waiter.wait(wait),
                _ => std::thread::sleep(wait),
            }
        });
    }
}
