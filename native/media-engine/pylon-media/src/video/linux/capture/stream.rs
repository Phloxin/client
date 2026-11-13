// The PipeWire side (D4, D5, D7): a video stream on the portal's remote, DMA-BUFs first in the
// formats the video processor takes with the modifiers the GPU imports, memory buffers when
// that cannot be agreed or the compositor's DMA-BUFs do not import.

use std::{
    cell::RefCell,
    collections::HashMap,
    io::Cursor,
    os::fd::{BorrowedFd, OwnedFd},
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};

use pipewire as pw;
use pw::spa::{
    self,
    param::{ParamType, format::{MediaSubtype, MediaType}, video::{VideoFormat, VideoInfoRaw}},
    pod::{ChoiceValue, Object, Pod, Property, PropertyFlags, Value, serialize::PodSerializer},
    sys as spa_sys,
    utils::{Choice, ChoiceEnum, ChoiceFlags, Fraction, Id, Rectangle, SpaTypes},
};

use super::{BufferId, CaptureEvent, CaptureInfo, Events, Held, Raw, Shared, ToLoop, egl, fourcc_text};
use crate::video::{DmaBufFrame, DmaBufObject, DmaBufPlane, EncoderConfig, VaapiEncoder};

/// What the portal said, for `capture_ready`.
pub(super) struct Context {
    pub restore_token: Option<String>,
    pub source: &'static str,
    pub cursor: &'static str,
    pub portal_size: Option<(i32, i32)>,
    /// The most frames a second to ask of the compositor (M5b D13).
    pub max_fps: Option<u32>,
}

/// The formats offered, in order, with their DRM fourccs: those the video processor converts.
const FORMATS: [(VideoFormat, &[u8; 4]); 4] = [
    (VideoFormat::BGRx, b"XR24"),
    (VideoFormat::BGRA, b"AR24"),
    (VideoFormat::RGBx, b"XB24"),
    (VideoFormat::RGBA, b"AB24"),
];

/// Without a first frame this long after a format was agreed, `capture_ready` goes out anyway.
const READY_WITHOUT_FRAME: Duration = Duration::from_secs(3);
/// Without an agreed format this long after the stream was connected, the capture failed.
const NO_FORMAT: Duration = Duration::from_secs(15);
const TIMER: Duration = Duration::from_millis(250);

fn fourcc_of(format: VideoFormat) -> Option<u32> {
    FORMATS.iter().find(|(f, _)| *f == format).map(|(_, c)| u32::from_le_bytes(**c))
}

fn serialize(object: Object) -> Result<Vec<u8>, String> {
    PodSerializer::serialize(Cursor::new(Vec::new()), &Value::Object(object))
        .map(|(cursor, _)| cursor.into_inner())
        .map_err(|e| format!("pod: {e:?}"))
}

fn property(key: u32, value: Value) -> Property {
    Property { key, flags: PropertyFlags::empty(), value }
}

/// One EnumFormat: `format` with `modifiers` (DMA-BUF) or without (memory).
fn format_pod(format: VideoFormat, modifiers: Option<&[u64]>, max_fps: Option<u32>) -> Result<Vec<u8>, String> {
    let mut properties = vec![
        property(spa_sys::SPA_FORMAT_mediaType, Value::Id(Id(MediaType::Video.as_raw()))),
        property(spa_sys::SPA_FORMAT_mediaSubtype, Value::Id(Id(MediaSubtype::Raw.as_raw()))),
        property(spa_sys::SPA_FORMAT_VIDEO_format, Value::Id(Id(format.as_raw()))),
    ];
    if let Some(modifiers) = modifiers {
        let alternatives: Vec<i64> = modifiers.iter().map(|&m| m as i64).collect();
        properties.push(Property {
            key: spa_sys::SPA_FORMAT_VIDEO_modifier,
            flags: PropertyFlags::MANDATORY | PropertyFlags::DONT_FIXATE,
            value: Value::Choice(ChoiceValue::Long(Choice(
                ChoiceFlags::empty(),
                ChoiceEnum::Enum { default: alternatives[0], alternatives },
            ))),
        });
    }
    properties.push(property(
        spa_sys::SPA_FORMAT_VIDEO_size,
        Value::Choice(ChoiceValue::Rectangle(Choice(
            ChoiceFlags::empty(),
            ChoiceEnum::Range {
                default: Rectangle { width: 1920, height: 1080 },
                min: Rectangle { width: 1, height: 1 },
                max: Rectangle { width: 8192, height: 8192 },
            },
        ))),
    ));
    properties.push(property(
        spa_sys::SPA_FORMAT_VIDEO_framerate,
        Value::Choice(ChoiceValue::Fraction(Choice(
            ChoiceFlags::empty(),
            ChoiceEnum::Range {
                default: Fraction { num: 60, denom: 1 },
                min: Fraction { num: 0, denom: 1 },
                max: Fraction { num: 1000, denom: 1 },
            },
        ))),
    ));
    if let Some(fps) = max_fps {
        // At most the share's rate from the compositor (M5b D13).
        properties.push(property(
            spa_sys::SPA_FORMAT_VIDEO_maxFramerate,
            Value::Choice(ChoiceValue::Fraction(Choice(
                ChoiceFlags::empty(),
                ChoiceEnum::Range {
                    default: Fraction { num: fps, denom: 1 },
                    min: Fraction { num: 1, denom: 1 },
                    max: Fraction { num: fps, denom: 1 },
                },
            ))),
        ));
    }
    serialize(Object { type_: SpaTypes::ObjectParamFormat.as_raw(), id: ParamType::EnumFormat.as_raw(), properties })
}

/// Every EnumFormat to offer: DMA-BUF ones first, then memory ones (as OBS orders them).
fn format_pods(modifiers: &[(u32, Vec<u64>)], memory_only: bool, max_fps: Option<u32>) -> Result<Vec<Vec<u8>>, String> {
    let mut pods = Vec::new();
    if !memory_only {
        for (format, fourcc) in FORMATS {
            let fourcc = u32::from_le_bytes(*fourcc);
            if let Some((_, list)) = modifiers.iter().find(|(f, list)| *f == fourcc && !list.is_empty()) {
                pods.push(format_pod(format, Some(list), max_fps)?);
            }
        }
    }
    for (format, _) in FORMATS {
        pods.push(format_pod(format, None, max_fps)?);
    }
    Ok(pods)
}

/// Buffers of the kinds `dmabuf` allows, and a header for the corrupted flag.
fn buffer_pods(dmabuf: bool) -> Result<Vec<Vec<u8>>, String> {
    let types = if dmabuf {
        1 << spa_sys::SPA_DATA_DmaBuf
    } else {
        (1 << spa_sys::SPA_DATA_MemFd) | (1 << spa_sys::SPA_DATA_MemPtr)
    };
    let buffers = serialize(Object {
        type_: SpaTypes::ObjectParamBuffers.as_raw(),
        id: ParamType::Buffers.as_raw(),
        properties: vec![property(spa_sys::SPA_PARAM_BUFFERS_dataType, Value::Int(types as i32))],
    })?;
    let header = serialize(Object {
        type_: SpaTypes::ObjectParamMeta.as_raw(),
        id: ParamType::Meta.as_raw(),
        properties: vec![
            property(spa_sys::SPA_PARAM_META_type, Value::Id(Id(spa_sys::SPA_META_Header))),
            property(spa_sys::SPA_PARAM_META_size, Value::Int(size_of::<spa_sys::spa_meta_header>() as i32)),
        ],
    })?;
    Ok(vec![buffers, header])
}

fn pods(bytes: &[Vec<u8>]) -> Result<Vec<&Pod>, String> {
    bytes.iter().map(|b| Pod::from_bytes(b).ok_or_else(|| "pod parse".to_string())).collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Negotiated {
    width: u32,
    height: u32,
    fourcc: u32,
    modifier: Option<u64>,
}

/// Whether a newly agreed format needs its DMA-BUFs checked again: only for another format or
/// modifier, not for another size (M5b D4).
fn needs_check(before: Option<Negotiated>, now: Negotiated, verified: bool) -> bool {
    if now.modifier.is_none() {
        return false;
    }
    !verified || before.is_none_or(|b| (b.fourcc, b.modifier) != (now.fourcc, now.modifier))
}

/// Whether `buffer` is still the stream's, in the generation it was handed out in.
fn is_live(live: &HashMap<usize, u64>, buffer: BufferId) -> bool {
    live.get(&buffer.address) == Some(&buffer.generation)
}

/// What the loop's callbacks share on its thread.
struct Local {
    negotiated: Option<Negotiated>,
    /// The buffers PipeWire has given the stream, by address, with the generation each was
    /// added in.
    live: HashMap<usize, u64>,
    generation: u64,
    /// The current DMA-BUF format was imported once successfully, or there is nothing to check.
    verified: bool,
    /// The encoder the import check uses, kept for the next check.
    checker: Option<VaapiEncoder>,
    memory_only: bool,
    ready: bool,
    streaming: bool,
    connected_at: Instant,
    format_at: Option<Instant>,
    /// What the capture ended with, once it has.
    over: Option<CaptureEvent>,
}

/// Frames the compositor flagged or left empty are given straight back.
///
/// # Safety
/// `buffer` is a buffer just dequeued from the stream.
unsafe fn usable(buffer: *mut pw::sys::pw_buffer) -> Option<&'static spa_sys::spa_data> {
    // SAFETY: a dequeued pw_buffer points to its spa_buffer, its metas and datas.
    unsafe {
        let spa = (*buffer).buffer;
        if spa.is_null() || (*spa).n_datas == 0 {
            return None;
        }
        let metas = std::slice::from_raw_parts((*spa).metas, (*spa).n_metas as usize);
        for meta in metas {
            if meta.type_ == spa_sys::SPA_META_Header && meta.size as usize >= size_of::<spa_sys::spa_meta_header>() {
                let header = &*(meta.data as *const spa_sys::spa_meta_header);
                if header.flags & spa_sys::SPA_META_HEADER_FLAG_CORRUPTED != 0 {
                    return None;
                }
            }
        }
        let data = &*(*spa).datas;
        if data.chunk.is_null() || (*data.chunk).flags & spa_sys::SPA_CHUNK_FLAG_CORRUPTED as i32 != 0 {
            return None;
        }
        // An empty chunk has no picture (a compositor may send one for the cursor alone).
        if (*data.chunk).size == 0 {
            return None;
        }
        Some(data)
    }
}

/// The DMA-BUF frame in `buffer`, its file descriptors duplicated.
///
/// # Safety
/// `buffer` is a usable buffer of DMA-BUF data.
unsafe fn dmabuf_frame(buffer: *mut pw::sys::pw_buffer, format: Negotiated, arrived: Instant) -> Result<DmaBufFrame, String> {
    // SAFETY: as for `usable`.
    unsafe {
        let spa = (*buffer).buffer;
        let datas = std::slice::from_raw_parts((*spa).datas, (*spa).n_datas as usize);
        let mut objects: Vec<DmaBufObject> = Vec::new();
        // The buffer behind each object, so planes of one buffer share it: a DCC modifier
        // gives several planes of one DMA-BUF, and the VA import takes a single object only.
        let mut buffers: Vec<(u64, u64)> = Vec::new();
        let mut planes = Vec::new();
        for (index, data) in datas.iter().enumerate() {
            if data.type_ != spa_sys::SPA_DATA_DmaBuf || data.chunk.is_null() {
                return Err(format!("plane {index} is not a DMA-BUF"));
            }
            if data.fd < 0 || data.fd > i32::MAX as i64 {
                return Err(format!("plane {index} has no file descriptor"));
            }
            let fd = BorrowedFd::borrow_raw(data.fd as i32).try_clone_to_owned().map_err(|e| format!("duplicate DMA-BUF: {e}"))?;
            let file = std::fs::File::from(fd);
            let meta = file.metadata().map_err(|e| format!("DMA-BUF stat: {e}"))?;
            let buffer = (std::os::unix::fs::MetadataExt::dev(&meta), std::os::unix::fs::MetadataExt::ino(&meta));
            let object = match buffers.iter().position(|b| *b == buffer) {
                Some(object) => {
                    objects[object].size = objects[object].size.max(data.maxsize as usize);
                    object
                }
                None => {
                    buffers.push(buffer);
                    objects.push(DmaBufObject {
                        fd: OwnedFd::from(file),
                        size: data.maxsize as usize,
                        modifier: format.modifier.unwrap_or(egl::DRM_FORMAT_MOD_INVALID),
                    });
                    objects.len() - 1
                }
            };
            let chunk = &*data.chunk;
            planes.push(DmaBufPlane { object, offset: chunk.offset as usize, pitch: chunk.stride.max(0) as usize });
        }
        Ok(DmaBufFrame { width: format.width, height: format.height, fourcc: format.fourcc, objects, planes, capture_time: arrived })
    }
}

/// Where the memory frame in `data` is, not copied yet, or `None` when it holds nothing.
///
/// # Safety
/// `data` is a mapped memory plane of a usable buffer.
unsafe fn memory_frame(data: &spa_sys::spa_data, format: Negotiated) -> Option<Raw> {
    // SAFETY: the stream maps memory buffers (MAP_BUFFERS), the chunk says what is valid.
    unsafe {
        let chunk = &*data.chunk;
        if data.data.is_null() || chunk.size == 0 || data.maxsize == 0 {
            return None;
        }
        let stride = chunk.stride.max(0) as usize;
        let offset = (chunk.offset % data.maxsize) as usize;
        let length = stride * format.height as usize;
        if stride < format.width as usize * 4 || offset + length > data.maxsize as usize {
            return None;
        }
        let start = (data.data as *const u8).add(offset) as usize;
        Some(Raw::Memory { width: format.width, height: format.height, fourcc: format.fourcc, stride, data: start })
    }
}

/// Imports one frame without encoding it, to find out whether the compositor's buffers work.
/// The encoder is made once and kept in `checker` for later checks.
fn check_import(checker: &mut Option<VaapiEncoder>, frame: &DmaBufFrame) -> Result<(), String> {
    let encoder = match checker {
        Some(encoder) => encoder,
        None => checker.insert(
            VaapiEncoder::new(EncoderConfig { width: 4096, height: 4096, fps: 60, start_bitrate: 1_000_000, filler: false })
                .map_err(|e| e.to_string())?,
        ),
    };
    encoder.try_import(frame).map_err(|e| e.to_string())
}

/// Runs the stream until it ends or the capture is stopped. An error before frames flowed is
/// the capture failing.
pub(super) fn run(remote: OwnedFd, node_id: u32, context: Context, shared: Arc<Shared>, events: Events) -> Result<(), String> {
    let modifiers = match egl::modifiers(&FORMATS.map(|(_, c)| u32::from_le_bytes(*c))) {
        Ok(modifiers) => {
            for (fourcc, list) in &modifiers {
                tracing::info!(format = %fourcc_text(*fourcc), count = list.len(), "DMA-BUF modifiers offered");
            }
            modifiers
        }
        Err(message) => {
            tracing::warn!(%message, "no DMA-BUF modifiers, offering memory buffers only");
            Vec::new()
        }
    };
    let formats = format_pods(&modifiers, modifiers.is_empty(), context.max_fps)?;

    pw::init();
    let mainloop = pw::main_loop::MainLoopRc::new(None).map_err(|e| format!("PipeWire loop: {e}"))?;
    let pw_context = pw::context::ContextRc::new(&mainloop, None).map_err(|e| format!("PipeWire context: {e}"))?;
    let core = pw_context.connect_fd_rc(remote, None).map_err(|e| format!("PipeWire remote: {e}"))?;
    let stream = pw::stream::StreamRc::new(
        core.clone(),
        "pylon-screen",
        pw::properties::properties! {
            *pw::keys::MEDIA_TYPE => "Video",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Screen",
        },
    )
    .map_err(|e| format!("PipeWire stream: {e}"))?;

    let local = Rc::new(RefCell::new(Local {
        negotiated: None,
        live: HashMap::new(),
        generation: 0,
        verified: false,
        checker: None,
        memory_only: modifiers.is_empty(),
        ready: false,
        streaming: false,
        connected_at: Instant::now(),
        format_at: None,
        over: None,
    }));
    let context = Rc::new(context);

    // Ends the loop with `event`, once.
    let end = {
        let local = local.clone();
        let mainloop = mainloop.clone();
        move |event: CaptureEvent| {
            let mut local = local.borrow_mut();
            if local.over.is_none() {
                local.over = Some(event);
            }
            mainloop.quit();
        }
    };
    let end = Rc::new(end);

    let ready = {
        let local = local.clone();
        let context = context.clone();
        let events = events.clone();
        move || {
            let mut l = local.borrow_mut();
            let Some(format) = l.negotiated else { return };
            if l.ready {
                return;
            }
            l.ready = true;
            let info = CaptureInfo {
                width: format.width,
                height: format.height,
                fourcc: format.fourcc,
                modifier: format.modifier,
                dmabuf: format.modifier.is_some(),
                restore_token: context.restore_token.clone(),
                source: context.source,
                cursor: context.cursor,
            };
            tracing::info!(
                width = info.width,
                height = info.height,
                format = %fourcc_text(info.fourcc),
                modifier = ?info.modifier.map(|m| format!("{m:#018x}")),
                buffers = if info.dmabuf { "dmabuf" } else { "memory" },
                verified = l.verified,
                source = info.source,
                cursor = info.cursor,
                portal_size = ?context.portal_size,
                "capture ready"
            );
            drop(l);
            events(CaptureEvent::Ready(info));
        }
    };
    let ready = Rc::new(ready);

    let _core_listener = {
        let end = end.clone();
        let local = local.clone();
        core.add_listener_local()
            .error(move |id, _seq, res, message| {
                tracing::warn!(id, res, message, "PipeWire core error");
                if id == pw::core::PW_ID_CORE {
                    let ready = local.borrow().ready;
                    end(if ready { CaptureEvent::Ended } else { CaptureEvent::Failed(format!("PipeWire: {message}")) });
                }
            })
            .register()
    };

    let _listener = {
        let (l1, l2, l3, l4, l5) = (local.clone(), local.clone(), local.clone(), local.clone(), local.clone());
        let (s1, s2, s3) = (shared.clone(), shared.clone(), shared.clone());
        let (end1, ready1) = (end.clone(), ready.clone());
        let events = events.clone();
        stream
            .add_local_listener_with_user_data(())
            .state_changed(move |_stream, _, old, new| {
                tracing::info!(?old, ?new, "capture stream");
                let mut l = l1.borrow_mut();
                match new {
                    pw::stream::StreamState::Streaming => l.streaming = true,
                    pw::stream::StreamState::Error(message) => {
                        let ready = l.ready;
                        drop(l);
                        end1(if ready { CaptureEvent::Ended } else { CaptureEvent::Failed(format!("PipeWire stream: {message}")) });
                    }
                    pw::stream::StreamState::Unconnected if l.streaming || l.ready => {
                        drop(l);
                        end1(CaptureEvent::Ended);
                    }
                    _ => {}
                }
            })
            .param_changed(move |stream, _, id, param| {
                let Some(param) = param else { return };
                if id != ParamType::Format.as_raw() {
                    return;
                }
                let mut info = VideoInfoRaw::new();
                if let Err(error) = info.parse(param) {
                    tracing::warn!(?error, "capture format did not parse");
                    return;
                }
                let has_modifier = param
                    .as_object()
                    .ok()
                    .and_then(|object| object.find_prop(Id(spa_sys::SPA_FORMAT_VIDEO_modifier)))
                    .is_some();
                let Some(fourcc) = fourcc_of(info.format()) else {
                    tracing::warn!(format = ?info.format(), "capture format is not one offered");
                    return;
                };
                let size = info.size();
                let format = Negotiated {
                    width: size.width,
                    height: size.height,
                    fourcc,
                    modifier: has_modifier.then(|| info.modifier()),
                };
                let mut l = l2.borrow_mut();
                let before = l.negotiated.replace(format);
                l.verified = !needs_check(before, format, l.verified);
                l.format_at = Some(Instant::now());
                let was_ready = l.ready;
                drop(l);
                tracing::info!(
                    width = format.width,
                    height = format.height,
                    format = %fourcc_text(fourcc),
                    modifier = ?format.modifier.map(|m| format!("{m:#018x}")),
                    framerate = ?info.framerate(),
                    max_framerate = ?info.max_framerate(),
                    buffers = if has_modifier { "dmabuf" } else { "memory" },
                    "capture format"
                );
                if let Ok(mut state) = s1.state.lock() {
                    state.path = if has_modifier { "dmabuf" } else { "memory" };
                }
                if was_ready && before.is_some_and(|b| (b.width, b.height) != (format.width, format.height)) {
                    events(CaptureEvent::Changed { width: format.width, height: format.height });
                }
                match buffer_pods(has_modifier).and_then(|bytes| {
                    let mut params = pods(&bytes)?;
                    stream.update_params(&mut params).map_err(|e| format!("buffer params: {e}"))
                }) {
                    Ok(()) => {}
                    Err(message) => tracing::error!(%message, "capture buffers"),
                }
            })
            .add_buffer(move |_stream, _, buffer| {
                let mut l = l3.borrow_mut();
                l.generation += 1;
                let generation = l.generation;
                l.live.insert(buffer as usize, generation);
            })
            .remove_buffer(move |_stream, _, buffer| {
                let removed = l4.borrow_mut().live.remove(&(buffer as usize));
                // Under the lock: a memory frame being copied is copied before its buffer goes.
                if let Ok(mut state) = s2.state.lock()
                    && let Some(generation) = removed
                    && state.pending.as_ref().is_some_and(|held| held.buffer == Some(BufferId { address: buffer as usize, generation }))
                {
                    state.pending = None;
                }
            })
            .process(move |stream, _| {
                loop {
                    // SAFETY: buffers are dequeued and queued on this thread only.
                    let buffer = unsafe { stream.dequeue_raw_buffer() };
                    if buffer.is_null() {
                        break;
                    }
                    let arrived = Instant::now();
                    // SAFETY: just dequeued.
                    let queue = || unsafe { stream.queue_raw_buffer(buffer) };
                    let (Some(format), Some(generation)) = ({
                        let l = l5.borrow();
                        (l.negotiated, l.live.get(&(buffer as usize)).copied())
                    }) else {
                        queue();
                        continue;
                    };
                    let id = BufferId { address: buffer as usize, generation };
                    // SAFETY: just dequeued.
                    let Some(data) = (unsafe { usable(buffer) }) else {
                        queue();
                        continue;
                    };
                    let held = if data.type_ == spa_sys::SPA_DATA_DmaBuf {
                        // SAFETY: a usable buffer of DMA-BUF data.
                        let frame = match unsafe { dmabuf_frame(buffer, format, arrived) } {
                            Ok(frame) => frame,
                            Err(message) => {
                                tracing::warn!(%message, "capture buffer skipped");
                                queue();
                                continue;
                            }
                        };
                        if !l5.borrow().verified {
                            let began = Instant::now();
                            let checked = check_import(&mut l5.borrow_mut().checker, &frame);
                            match checked {
                                Ok(()) => {
                                    tracing::info!(
                                        ms = began.elapsed().as_millis() as u64,
                                        planes = frame.planes.len(),
                                        objects = frame.objects.len(),
                                        "the compositor's DMA-BUFs import"
                                    );
                                    l5.borrow_mut().verified = true;
                                }
                                Err(message) => {
                                    tracing::error!(
                                        %message,
                                        planes = frame.planes.len(),
                                        objects = frame.objects.len(),
                                        format = %fourcc_text(format.fourcc),
                                        modifier = ?format.modifier.map(|m| format!("{m:#018x}")),
                                        "THE COMPOSITOR'S DMA-BUFS DO NOT IMPORT, falling back to memory buffers"
                                    );
                                    l5.borrow_mut().memory_only = true;
                                    queue();
                                    s3.send(ToLoop::Memory);
                                    continue;
                                }
                            }
                        }
                        Held { buffer: Some(id), raw: Raw::DmaBuf(frame), arrived }
                    } else if data.type_ == spa_sys::SPA_DATA_MemFd || data.type_ == spa_sys::SPA_DATA_MemPtr {
                        // Held, not copied: only the frame the pipeline takes is copied.
                        // SAFETY: a mapped memory plane of a usable buffer.
                        let Some(raw) = (unsafe { memory_frame(data, format) }) else {
                            queue();
                            continue;
                        };
                        Held { buffer: Some(id), raw, arrived }
                    } else {
                        queue();
                        continue;
                    };

                    let replaced = match s3.state.lock() {
                        Ok(mut state) => {
                            state.delivered += 1;
                            let replaced = state.pending.replace(held);
                            state.dropped += u64::from(replaced.is_some());
                            replaced
                        }
                        Err(_) => None,
                    };
                    s3.changed.notify_all();
                    if let Some(old) = replaced.and_then(|old| old.buffer)
                        && is_live(&l5.borrow().live, old)
                    {
                        // SAFETY: a live buffer this stream dequeued and still held.
                        unsafe { stream.queue_raw_buffer(old.address as *mut pw::sys::pw_buffer) };
                    }
                    ready1();
                }
            })
            .register()
            .map_err(|e| format!("PipeWire listener: {e}"))?
    };

    let (to_loop, from_others) = pw::channel::channel::<ToLoop>();
    if let Ok(mut slot) = shared.to_loop.lock() {
        *slot = Some(to_loop);
    }
    let _receiver = {
        let stream = stream.clone();
        let local = local.clone();
        let quit = mainloop.clone();
        let modifiers = modifiers.clone();
        let max_fps = context.max_fps;
        from_others.attach(mainloop.loop_(), move |message| match message {
            ToLoop::Release(buffer) => {
                // A buffer of an earlier generation is gone, even if a new one has its address.
                if is_live(&local.borrow().live, buffer) {
                    // SAFETY: a live buffer of this stream that the pipeline was given.
                    unsafe { stream.queue_raw_buffer(buffer.address as *mut pw::sys::pw_buffer) };
                }
            }
            ToLoop::Stop => quit.quit(),
            ToLoop::Memory => {
                let result = format_pods(&modifiers, true, max_fps).and_then(|bytes| {
                    let mut params = pods(&bytes)?;
                    stream.update_params(&mut params).map_err(|e| format!("memory formats: {e}"))
                });
                if let Err(message) = result {
                    tracing::error!(%message, "capture could not ask for memory buffers");
                }
            }
        })
    };

    // Stop and the time limits, looked at a few times a second.
    let timer = {
        let local = local.clone();
        let shared = shared.clone();
        let end = end.clone();
        let ready = ready.clone();
        mainloop.loop_().add_timer(move |_| {
            if shared.stop.load(std::sync::atomic::Ordering::Relaxed) {
                end(CaptureEvent::Ended);
                return;
            }
            let (has_format, is_ready, format_at, connected_at) = {
                let l = local.borrow();
                (l.negotiated.is_some(), l.ready, l.format_at, l.connected_at)
            };
            if is_ready {
                return;
            }
            if let Some(at) = format_at
                && at.elapsed() >= READY_WITHOUT_FRAME
            {
                tracing::warn!("no frame since the format was agreed, ready without one");
                ready();
            } else if !has_format && connected_at.elapsed() >= NO_FORMAT {
                end(CaptureEvent::Failed(format!("no format agreed with the compositor within {} s", NO_FORMAT.as_secs())));
            }
        })
    };
    timer.update_timer(Some(TIMER), Some(TIMER)).into_result().map_err(|e| format!("timer: {e}"))?;

    let mut params = pods(&formats)?;
    stream
        .connect(
            spa::utils::Direction::Input,
            Some(node_id),
            pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
            &mut params,
        )
        .map_err(|e| format!("PipeWire connect: {e}"))?;
    local.borrow_mut().connected_at = Instant::now();
    tracing::info!(node_id, offered = formats.len(), "capture stream connecting");

    mainloop.run();

    let over = local.borrow_mut().over.take();
    if let Ok(mut slot) = shared.to_loop.lock() {
        *slot = None;
    }
    // A memory frame points into a buffer that the disconnect unmaps.
    if let Ok(mut state) = shared.state.lock() {
        state.pending = None;
    }
    let _ = stream.disconnect();
    let stopped = shared.stop.load(std::sync::atomic::Ordering::Relaxed);
    match over {
        Some(CaptureEvent::Failed(message)) => Err(message),
        Some(CaptureEvent::Ended) if !stopped => {
            tracing::info!("screen capture ended");
            events(CaptureEvent::Ended);
            Ok(())
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_new_format_or_modifier_is_checked_again() {
        let xr24 = u32::from_le_bytes(*b"XR24");
        let ar24 = u32::from_le_bytes(*b"AR24");
        let dmabuf = |width, fourcc, modifier| Negotiated { width, height: 900, fourcc, modifier: Some(modifier) };
        let first = dmabuf(1000, xr24, 7);
        assert!(needs_check(None, first, false));
        // A resize of a checked format: no new check.
        assert!(!needs_check(Some(first), dmabuf(1100, xr24, 7), true));
        // Not checked yet, or failed: checked.
        assert!(needs_check(Some(first), dmabuf(1100, xr24, 7), false));
        assert!(needs_check(Some(first), dmabuf(1000, ar24, 7), true));
        assert!(needs_check(Some(first), dmabuf(1000, xr24, 8), true));
        // Memory buffers have nothing to check.
        assert!(!needs_check(Some(first), Negotiated { modifier: None, ..first }, false));
        let memory = Negotiated { modifier: None, ..first };
        assert!(needs_check(Some(memory), first, true));
    }

    /// On the GPU: run with `--ignored`. Pattern DMA-BUFs of several sizes through one checker.
    #[test]
    #[ignore]
    fn gpu_one_checker_for_several_sizes() {
        use crate::{
            SourceControl,
            video::{FrameProducer, PatternKind, PatternProducer, Produced},
        };
        let control = SourceControl::default();
        let mut checker = None;
        for (w, h) in [(1000, 900), (1100, 950), (1200, 1000), (1000, 900)] {
            let Produced::Frame(frame) = PatternProducer::new(w, h, 60, false, PatternKind::Screen).unwrap().next_frame(&control, Instant::now()).unwrap()
            else {
                panic!("no pattern frame");
            };
            let began = Instant::now();
            check_import(&mut checker, &frame).unwrap();
            eprintln!("{w}x{h} checked in {:.1} ms", began.elapsed().as_secs_f64() * 1000.0);
        }
        assert!(checker.is_some());
    }

    #[test]
    fn a_buffer_of_an_earlier_generation_is_not_live() {
        let mut live = HashMap::new();
        live.insert(0x1000, 3);
        assert!(is_live(&live, BufferId { address: 0x1000, generation: 3 }));
        // Removed and added again at the same address: a late release of the old one is refused.
        live.insert(0x1000, 9);
        assert!(!is_live(&live, BufferId { address: 0x1000, generation: 3 }));
        assert!(!is_live(&live, BufferId { address: 0x2000, generation: 9 }));
    }
}
