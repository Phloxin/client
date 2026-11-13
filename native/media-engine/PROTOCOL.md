# pylon-media-host control protocol, version 1

`pylon-media-host` is the sidecar around the `pylon-media` engine. A host program (the probe
today, the Electron main process later) starts it and drives one sending session with JSON
lines.

```
pylon-media-host [--insecure-plain] [--test-hooks]
```

- `--insecure-plain`: allows `open` with `"e2ee": null` (media in the clear). Without it such an
  `open` is a fatal error.
- `--test-hooks`: allows the `synthetic` source and `test_drop_media`. Without it they are
  refused.
- Any other argument: a usage line on stderr and exit status 2.
- `PYLON_MEDIA_LOG`: the log filter for stderr, in `tracing` env-filter syntax (`info`,
  `debug`, `info,pylon_media=debug`). Default `info`. Key bytes are never logged.

## Framing

- One JSON object per line, UTF-8, `\n` at the end. Empty lines are ignored.
- Every message is externally tagged with a snake_case name: `{"name": {fields}}`. The object
  has exactly one key.
- stdin carries requests from the host. stdout carries messages from the sidecar and nothing
  else. Logs go to stderr.
- Every message from the sidecar carries `t_ms`: milliseconds since the sidecar started, a
  number with up to three decimals.
- Unknown fields in a request are ignored.
- Bitrates are bits per second.

## A normal session

```
host                                          sidecar
{"hello": {"protocol": 1}}               ->
                                         <-   {"hello": {..., "t_ms": 0.05}}
{"open": {...}}                          ->
                                         <-   {"opened": {"dtls_parameters", "rtp_parameters", ...}}
  host: ConnectTransport with dtls_parameters, CreateSource with rtp_parameters
{"start": {}}                            ->
                                         <-   {"ice_state": {"state": "checking", ...}}
                                         <-   {"ice_state": {"state": "completed", ...}}
                                         <-   {"connected": {...}}
                                         <-   {"stats": {...}}               once a second
                                         <-   {"key_frame_request": {...}}   when the node asks
{"key": {...}}                           ->   when the epoch changes
{"preview": {...}}                       ->   any time after opened, if wanted
                                         <-   {"preview": {...}}             a few a second
{"close": {}}                            ->
                                         <-   {"closed": {"reason": "close", ...}}
  sidecar exits with status 0
```

ICE and DTLS start as soon as `open` is answered, so `ice_state` and `connected` may come
before or after `start`. Media flows once both `start` was received and the transport is
connected.

A screen share captures first, because a person may take long in the portal's dialog (Linux)
and the node's stream should not exist before there is something to send:

```
{"hello": {"protocol": 1}}               ->
                                         <-   {"hello": {..., "sources": [..., "screen"]}}
{"capture": {"screen": {"restore_token": null}}} ->
  the portal's dialog, for as long as the person takes
                                         <-   {"capture_ready": {"width", "height", ...}}
                                              or {"capture_cancelled": {}}
{"open": {... "source": {"screen": {...}}}} ->
  and on as above
```

## Host to sidecar

### `hello`

Must be the first message. Answered with `hello`. A `protocol` other than 1 is a fatal error.
Any other request before `hello` (except `close`) is an error that is not fatal and is
otherwise ignored. A second `hello` is an error that is not fatal.

| field | type | |
|---|---|---|
| `protocol` | integer | 1 |

```json
{"hello": {"protocol": 1}}
```

### `capture`

On Linux, starts a screen capture through the desktop portal's ScreenCast: the portal's dialog
offers monitors and windows, one source, with the cursor in the picture when the portal can draw
it there (else no cursor, the log says which). The choice is asked to be remembered, and a
`restore_token` from an earlier `capture_ready` is tried first, so the portal may answer
without a dialog. Allowed once, before `open`. No answer until the person has chosen:
`capture_ready`, or `capture_cancelled` when they said no, or a fatal `error` when the portal
or PipeWire is not there or failed (the host may then use another path). There is no timeout.
`target` is ignored.

On Windows, starts Windows Graphics Capture of the `target`: a window by its handle, or the
monitor that holds a point, or the primary monitor when `target` is left out. There is no
dialog (the host's own picker chose), so `capture_cancelled` never comes, and `restore_token`
is ignored. The cursor is drawn into the picture. Windows' yellow border around the captured
item is turned off where Windows allows it (the log says whether it did). The sidecar is
per-monitor DPI aware, so window and monitor sizes and the point are physical pixels. Answered
with `capture_ready` once the first frame came (or after 3 s without one). A target that does
not exist (a window that closed, a point on no monitor) is a fatal `error` that says so, as is
a capture that cannot start.

Only in a sidecar built with the `capture` feature on Linux or Windows. Without it, or on
another system, `capture` is a fatal error and `hello` does not list `screen`. A second
`capture`, or one after `open`, is an error that is not fatal.

| field | type | |
|---|---|---|
| `screen` | object | `restore_token`: string or `null` (may be left out), Linux only. `max_fps`: integer 1 to 240 or `null` (may be left out), the most frames a second asked of the compositor in the PipeWire negotiation (Linux) or set as the capture's least time between frames (Windows, where Windows has the setting), the share's rate. Outside 1 to 240 it is a fatal error. `target` (may be left out), Windows only: `{"window": <handle as a number>}` or `{"monitor": {"x": <px>, "y": <px>}}`, a point in physical pixels of the virtual screen |

```json
{"capture": {"screen": {"restore_token": null, "max_fps": 60}}}
{"capture": {"screen": {"max_fps": 60, "target": {"window": 1311922}}}}
{"capture": {"screen": {"max_fps": 60, "target": {"monitor": {"x": 0, "y": 0}}}}}
```

### `open`

Opens the one session of this process: binds the socket, starts ICE and DTLS toward the node's
transport. Answered with `opened`. All five fields are required (`e2ee` may be `null` but must
be present).

A second `open` is an error that is not fatal. An `open` that fails for any reason (fields that
do not parse, parameters the engine cannot use, a refused `null` or `synthetic`, a file that
cannot be read) is a fatal error.

| field | type | |
|---|---|---|
| `router_rtp_capabilities` | object | the router's RTP capabilities, as the node sends them (mediasoup's camelCase) |
| `transport` | object | the send transport's parameters, untouched: `id`, `ice_parameters`, `ice_candidates`, `dtls_parameters` (camelCase inside) |
| `e2ee` | object or `null` | frame encryption, see below. `null` is refused without `--insecure-plain` |
| `source` | object | where frames come from, see below |
| `video` | object | `start_bitrate`, `max_bitrate`, integers 1 to 1000000000, and `codec` (optional): `"H264"` (the default) or `"AV1"`, anything else is a fatal error. See "AV1" below |

`e2ee`, fixed for the life of the session except for what `key` replaces:

| field | type | |
|---|---|---|
| `format` | integer | frame format, 1 |
| `epoch` | integer 0 to 255 | |
| `key` | string | base64 (standard alphabet, padded) of exactly 16 bytes |
| `kid` | integer 0 to 255 | the sender process id in the frame trailer |
| `counter` | integer 0 to 2^32 - 1 | where the frame counter starts |
| `source` | object | the source binding of the AAD: `tag` (1 mic, 2 webcam, 3 stream, 4 stream audio) and `stream_key` (string for tags 3 and 4, absent or `null` otherwise) |

`source`, one of:

| | |
|---|---|
| `{"file": {"path": "<Annex-B H264 file>", "fps": 30}}` | the file's access units, one per frame interval by the wall clock, looping. With `"codec": "AV1"` the file is IVF of AV1 and its temporal units are sent the same way (a key frame is one with a sequence header) |
| `{"synthetic": {"fps": 30}}` | made-up H264 that follows the target bitrate. Only with `--test-hooks`, only with `"e2ee": null`, and only H264 (fatal with `"codec": "AV1"`) |
| `{"pattern": {"width": 1920, "height": 1080, "fps": 60, "kind": "screen", "still": false}}` | a test pattern drawn by the sidecar, handed to the hardware encoder as a DMA-BUF (Linux) or a D3D11 texture (Windows) and sent at its own size and rate, with a frame counter and a UTC clock. `kind` (optional, default `"screen"`): `"screen"` is still colour bars with a small moving box and every 10 s a cut to or from a page of text that scrolls slowly, `"stress"` a field of fine detail and noise moving every frame with a full change every 10 s. `still` (optional, default `false`): the first frame repeated unchanged. Only in a sidecar built with the `encode` feature, refused (fatal) otherwise. Needs no flag, works with or without `e2ee` |

| `{"screen": {"fps": 60, "max_width": 1920, "max_height": 1080}}` | the captured screen, after `capture_ready`, handed to the hardware encoder as the compositor's DMA-BUFs (or uploaded from memory when those cannot be used) on Linux, as the capture's own D3D11 textures on Windows. The capture's own size is sent, scaled down to fit `max_width` by `max_height` and never up. Frames come when the screen changes, at most `fps` a second go to the encoder (the newest wins), and when nothing changes nothing is sent. A key frame asked for while nothing changes is made from the last frame. A changed size (a resized window) is reported as `capture_changed`. The encoder takes it up only once it has stayed the same for 300 ms, and not sooner than 1 s after the encoder was last opened: then it opens again at the new size with a key frame. Until then frames are scaled to the size the encoder runs at, and if nothing newer comes the last frame is encoded again at the new size once it is taken up. A frame held back by the frame rate divisor or a deep send queue is sent once they allow, when nothing newer came. Only in a sidecar built with the `capture` feature. Before `capture_ready` it is a fatal error |

`fps` is 1 to 240. A pattern's `width` and `height` are even, 16 to 4096. A screen's
`max_width` and `max_height` are 16 to 4096. Whatever the source's size, the encoded size stays
within the sizes the GPU's driver encodes (on Linux what the driver says, on radeonsi 128 to
4096 a side; on Windows 160x120 to 4096x2304): a smaller picture is scaled up to the least
size. If the encoder cannot be opened again at a new size, it goes on at the size it runs at
and tries again with the next settled size.

Which sources exist where: `file` everywhere; `pattern` on Linux and Windows in a sidecar built
with the `encode` feature; `screen` (and `capture`) on Linux and Windows in one built with the
`capture` feature; `synthetic` under `--test-hooks`.

The engine picks the session's codec (H264 unless `video.codec` says AV1) and its RTX payload
type and the mid, abs-send-time and transport-wide-cc header extension ids from
`router_rtp_capabilities`, and uses the transport's first UDP candidate (TCP candidates are
ignored) and its sha-256 fingerprint. A router without the codec or its RTX is a fatal error.

AV1 (`"codec": "AV1"`, AV1 step 2): the router's `video/AV1` entry with its `profile`,
`level-idx` and `tier`, and the Dependency Descriptor header extension
(`https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension`) at the
id the router gives, which the router must have (mediasoup finds AV1 key frames only through
it). Packets follow the AV1 RTP payload format: OBU elements without their size fields,
temporal delimiters and tile lists left out, at most 1100 bytes of payload, N on the first
packet of a key frame. Every packet carries the descriptor's mandatory fields (3 bytes), the
first packet of a key frame also its template structure (9 bytes): one decode target, one
chain, a key frame template and one that depends on the frame before, the frame number counting
frames sent. The `pattern` and `screen` sources encode with `av1_vaapi` (level 5.1) on Linux,
`file` reads IVF. On Windows an AV1 `open` is a fatal error. Frames are encrypted with the E2EE
format's AV1 codec.

```json
{"open": {
  "router_rtp_capabilities": {"codecs": [...], "headerExtensions": [...]},
  "transport": {"id": "5ab0b66c", "ice_parameters": {...}, "ice_candidates": [...], "dtls_parameters": {...}},
  "e2ee": {"format": 1, "epoch": 0, "key": "AAECAwQFBgcICQoLDA0ODw==", "kid": 1, "counter": 12345,
           "source": {"tag": 3, "stream_key": "probe-stream"}},
  "source": {"file": {"path": "/tmp/testsrc2-720p30.h264", "fps": 30}},
  "video": {"start_bitrate": 1500000, "max_bitrate": 8000000}}}
```

### `start`

Hands the source to the engine. Media flows once the transport is connected. Before `opened`,
or a second time, it is an error that is not fatal. No answer.

```json
{"start": {}}
```

### `key`

Replaces the frame key: format, epoch and key. The kid and the counter carry on. An error that
is not fatal before `opened`, for a session opened with `"e2ee": null`, for an unknown format
or for a key that is not 16 bytes of base64. No answer.

| field | type | |
|---|---|---|
| `format` | integer | 1 |
| `epoch` | integer 0 to 255 | |
| `key` | string | base64 of 16 bytes |

```json
{"key": {"format": 1, "epoch": 1, "key": "AAECAwQFBgcICQoLDA0ODw=="}}
```

### `set_max_bitrate`

Caps the target bitrate and what the bandwidth estimator probes for. An error that is not fatal
before `opened` or outside 1 to 1000000000. No answer.

```json
{"set_max_bitrate": {"bps": 4000000}}
```

### `preview`

Asks for the sharer's preview: a small JPEG of what is being shared, a few times a second, as
`preview` messages. Allowed at any time after `opened`, and again to change it; each request
replaces the one before. No preview is made unless asked. No answer: the pictures follow.

| field | type | |
|---|---|---|
| `fps` | integer 0 to 10 | the most pictures a second. `0` stops the preview |
| `max_width` | integer 16 to 1280 | each picture fits into `max_width` by `max_height` with the frame's shape kept, never larger than the frame, even sides |
| `max_height` | integer 16 to 720 | |

Each picture is taken from the frame the encoder has just converted (the size being encoded), on
a thread of its own: it is scaled down (on the GPU on Linux, on the CPU after the read back on
Windows), read back and compressed as JPEG. Nothing the
share does waits for it; a frame the preview is not ready for is simply not previewed. The first
picture after a request is made from the last frame (so a share of something that does not move
shows its picture), after that pictures follow new frames only, at most `fps` a second: a screen
that does not change sends no more pictures.

The pictures are the sharer's screen. They are sent only to the host on stdout, never logged and
never sent to the network.

An error that is not fatal, the share going on: before `opened`; a field outside its range (the
request is ignored, the one before stays); a source without a picture (`file`, `synthetic`: "the
file source has no picture to preview"). If making a picture fails, the preview stops with an error
that is not fatal (its message starts with `preview:`) and the share goes on; a new request starts
it again.

```json
{"preview": {"fps": 5, "max_width": 480, "max_height": 270}}
{"preview": {"fps": 0, "max_width": 480, "max_height": 270}}
```

### `test_drop_media`

Test hook: throws the next `count` media packets away between the transport and the socket, to
exercise NACK and RTX. Refused (an error that is not fatal) without `--test-hooks`, and before
`opened`. No answer.

```json
{"test_drop_media": {"count": 40}}
```

### `close`

Stops the engine. The sidecar answers `closed` with reason `close` and exits with status 0.
Accepted at any time.

```json
{"close": {}}
```

## Sidecar to host

### `hello`

| field | |
|---|---|
| `protocol` | 1 |
| `engine` | the `pylon-media-host` crate version |
| `codecs` | `["H264"]`, and `"AV1"` after it when this sidecar can encode AV1 here: built with `encode` on Linux, FFmpeg with `av1_vaapi`, and a driver with an AV1 Profile 0 encode config (asked once per process, no encoder opened) |
| `sources` | the sources `open` accepts: `["file"]`, `"pattern"` in a sidecar built with the `encode` feature, `"screen"` (and with it `capture`) in one built with the `capture` feature, both on Linux and Windows only, `"synthetic"` under `--test-hooks` |

```json
{"hello": {"protocol": 1, "engine": "0.1.0", "codecs": ["H264"], "sources": ["file"], "t_ms": 0.05}}
```

### `capture_ready`

The person chose (Linux) and frames flow. What was agreed with the compositor:

| field | |
|---|---|
| `width`, `height` | the capture's size (on Windows the captured window's or monitor's size) |
| `format` | DRM fourcc of the frames, e.g. `"AR24"` (BGRA), `"XR24"` (BGRx). `null` on Windows, where frames are BGRA D3D11 textures |
| `modifier` | the DMA-BUF modifier as a string, `"0x"` and 16 hex digits (a JSON number would lose digits in JavaScript), `null` on the memory path and on Windows |
| `dmabuf` | `true`: frames reach the encoder as the compositor's DMA-BUFs, checked by importing the first. `false`: they are copied out of memory buffers and uploaded, because no DMA-BUF format was agreed or the compositor's DMA-BUFs did not import. Always `false` on Windows, where they reach the encoder as the capture's own textures, with no copy |
| `restore_token` | for the next `capture`, or `null` when the portal gave none. Always `null` on Windows |

```json
{"capture_ready": {"width": 2560, "height": 1440, "format": "AR24", "modifier": "0x0200000028a6bf04",
  "dmabuf": true, "restore_token": null, "t_ms": 2797.6}}
{"capture_ready": {"width": 1920, "height": 1080, "format": null, "modifier": null,
  "dmabuf": false, "restore_token": null, "t_ms": 137.9}}
```

### `capture_cancelled`

The person said no in the portal's dialog: the share is off. The sidecar waits for `close`. Never
on Windows, where nobody is asked.

```json
{"capture_cancelled": {"t_ms": 4120.2}}
```

### `capture_changed`

The captured source changed its size (a resized window; on Windows the size of the window's content, to which the capture follows). The encoder opens again at the new
size (fitted to the maximum) with a key frame once the size has stayed the same for 300 ms and
at least 1 s has passed since it was last opened. Until then frames are scaled to the size it runs
at.

```json
{"capture_changed": {"width": 1280, "height": 900, "t_ms": 31200.4}}
```

### `opened`

Both values are for the host to forward to the node untouched.

| field | |
|---|---|
| `dtls_parameters` | for `ConnectTransport`: `{"role": "client", "fingerprints": [{"algorithm": "sha-256", "value": "AB:..."}]}` |
| `rtp_parameters` | for `CreateSource`: mid `"0"`, the session's codec (H264 or AV1) and RTX with the router's payload types, the three header extensions (four with AV1: the Dependency Descriptor), one encoding with a random SSRC and RTX SSRC, and str0m's random CNAME |

```json
{"opened": {
  "dtls_parameters": {"role": "client", "fingerprints": [{"algorithm": "sha-256", "value": "3F:...:9A"}]},
  "rtp_parameters": {"mid": "0", "codecs": [...], "headerExtensions": [...],
                     "encodings": [{"ssrc": 4074920211, "rtx": {"ssrc": 1292475779}}],
                     "rtcp": {"cname": "Qx3...", "reducedSize": true}},
  "t_ms": 30.75}}
```

### `ice_state`

`state`: `new`, `checking`, `connected`, `completed` or `disconnected`.

```json
{"ice_state": {"state": "checking", "t_ms": 30.8}}
```

### `connected`

ICE and DTLS are done, SRTP is ready.

```json
{"connected": {"t_ms": 31.9}}
```

### `key_frame_request`

The node asked for a key frame. `kind`: `pli` or `fir`. A source that can make key frames makes
one (the pattern source: the next encoded frame, at most one every 500 ms), the file source
ignores it.

```json
{"key_frame_request": {"kind": "pli", "t_ms": 8037.4}}
```

### `stats`

Once a second after `connected`. Counters are totals since `open`.

| field | |
|---|---|
| `ms_since_open` | |
| `frames_sent` | frames handed to the transport |
| `key_frames_sent` | of those, key frames |
| `frames_dropped_source` | frames the source could not hand over because the engine was behind |
| `frames_dropped_encryption` | frames dropped because encryption failed (never sent in the clear) |
| `media_packets_sent`, `media_bytes_sent` | media packets and their bytes (SRTP) on the socket |
| `rtx_packets_sent` | packets on the RTX stream: retransmissions and probe padding |
| `queued_packets` | packets waiting in str0m's send queue (media, resends, padding) at that moment |
| `queued_packets_max` | the highest `queued_packets` since the last `stats` (the queue is read on every turn of the transport loop) |
| `queued_bytes`, `queued_bytes_max` | the same queue in bytes, now and the highest since the last `stats` |
| `queued_ms_max` | the highest queue since the last `stats` in milliseconds of the target bitrate at that moment |
| `bandwidth_estimate_bps` | the estimate from transport-wide feedback, `null` before the first |
| `target_bitrate_bps` | what the source is asked for: 0.9 of the estimate, at most the max bitrate |
| `frames_skipped_backlog` | frames the encoder did not encode because more than 200 ms of the target bitrate was waiting in the send queue |
| `frames_skipped_rate` | frames not encoded because the frame rate gave way: when the encoder cannot get down to the target, one frame in N is encoded, evenly |
| `frame_rate_divisor` | that N now (1, 2, 3, 4, 6 or 10), `null` for sources without an encoder |
| `encoder_bitrate_bps` | the bitrate the encoder is configured for now: the target scaled down by the encoder's overshoot over the last second, 0.7 to 1.0 of it. `null` for sources without an encoder |
| `encoder_output_bps` | what the encoder produced over the last second. `null` before a second has passed and for sources without an encoder |
| `encode_ms_median`, `encode_ms_max` | encode time per frame since the last `stats` (DMA-BUF import or the D3D11 video processor, colour conversion and encode), `null` without frames |
| `key_frames_forced` | key frames the encoder made because one was asked for (not the first) |
| `key_frames_repeated` | of those, key frames made from the last frame because nothing new had come for two frame intervals |
| `capture_frames_delivered` | frames the compositor (Windows Graphics Capture on Windows) delivered, `null` for sources other than `screen` |
| `capture_frames_taken` | of those, frames handed to the encoder (at most `fps` a second) |
| `capture_frames_dropped_rate` | frames a newer one replaced before the encoder took them |
| `capture_buffer_path` | `"dmabuf"` or `"memory"` on Linux, the path frames take now; `"d3d11"` on Windows |
| `capture_delay_ms_median`, `capture_delay_ms_max` | from a frame arriving from the compositor to the encoder taking it (with the upload on the memory path), since the last `stats`, `null` without frames |
| `rtt_ms`, `loss_fraction` | when str0m has them, else `null` |
| `nacks`, `plis`, `firs` | received from the node |
| `dtls_version` | e.g. `"DTLS1_2"` |

```json
{"stats": {"ms_since_open": 2019, "frames_sent": 60, "key_frames_sent": 1,
  "frames_dropped_source": 0, "frames_dropped_encryption": 0, "media_packets_sent": 1694,
  "media_bytes_sent": 1890224, "rtx_packets_sent": 6, "queued_packets": 0,
  "bandwidth_estimate_bps": 8253766, "target_bitrate_bps": 7428389, "rtt_ms": 0.37,
  "loss_fraction": 0.0, "nacks": 0, "plis": 0, "firs": 0, "dtls_version": "DTLS1_2",
  "t_ms": 2042.5}}
```

### `preview`

One picture of the sharer's preview, after a `preview` request. Only to the host (see the
request).

| field | |
|---|---|
| `width`, `height` | the picture's size |
| `jpeg` | the JPEG file as base64 (standard alphabet, padded): YUV 4:2:0, full range, BT.601, as JPEG viewers take it |
| `t_ms` | as on every message: when it was written |

```json
{"preview": {"width": 480, "height": 270, "jpeg": "/9j/4AAQSkZJRgABAgAAAQABAAD...", "t_ms": 10075.2}}
```

### `error`

| field | |
|---|---|
| `message` | what went wrong |
| `fatal` | `true`: the session is over, `closed` follows and the sidecar exits with status 1. `false`: the request was ignored and everything else carries on |

Not fatal: a line that is not JSON, an unknown message, a request with fields that do not
parse (other than `open`), a request out of order, a refused `test_drop_media`, a second
`open`, a second `capture` or one after `open`, a refused `preview` and a preview that stopped. Fatal: a protocol other than 1, any failed
`open`, `capture` without the feature, a capture that failed (the portal or PipeWire, Windows Graphics Capture, a Windows target that does not exist), an
engine failure after `open` (also a source that stopped, or an engine thread that ended
without closing).

A message never repeats what the host sent, because a line may carry the frame key: a line
that is not JSON is reported by its line and column, an unknown message by its name only when
that is lower case letters and underscores, fields that do not fit as the message's name and
either the missing field's name or `the fields do not fit the message`, a key that is not
base64 as `key is not base64`.

```json
{"error": {"message": "unknown message dance", "fatal": false, "t_ms": 0.09}}
{"error": {"message": "open: e2ee null is refused without --insecure-plain", "fatal": true, "t_ms": 0.1}}
```

### `closed`

The last message. `reason`:

| reason | | exit status |
|---|---|---|
| `close` | the host sent `close` | 0 |
| `end_of_input` | stdin ended (the host is gone or closed the pipe) | 0 |
| `error` | after a fatal `error` | 1 |
| `disconnected` | the transport stopped by itself | 1 |
| `capture_ended` | the screen capture ended by itself (stopped from the compositor, the window closed) | 0 |

```json
{"closed": {"reason": "end_of_input", "t_ms": 21059.5}}
```

## The host going away

The sidecar reads stdin on its own thread and treats end of input (or a read error) like
`close`: it stops the engine, writes `closed` if it still can and exits with status 0. If
stdout cannot be written, it stops the engine and exits with status 1. A sidecar whose host
has gone does not keep running or sending.

Once the sidecar has decided to exit, for any reason, it is gone within 2 s: if stopping the
capture and the engine takes longer (a GPU call that hangs), it ends itself with the exit
status it had decided on, without writing `closed`. The capture is stopped before the engine
is waited for. A release build aborts on a panic in any thread.
