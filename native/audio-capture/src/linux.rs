//! PipeWire backend: per-app / system audio capture for screenshare.
//!
//! Capture topology (venmic-style):
//!   [app playback nodes] --links--> [our null sink] --monitor--> [capture stream] --> JS
//!
//! A `support.null-audio-sink` node is created for the share, selected app
//! playback streams (`Stream/Output/Audio` nodes) are linked into it by port,
//! and a capture stream records the sink's monitor. PipeWire mixes multiple
//! links on a port natively, and the stream's adapter resamples to the wire
//! format (48kHz f32 interleaved stereo). Plain 'system' mode skips all of
//! that and captures the default sink's monitor directly.
//!
//! App targeting is by PID: every playback node whose application.process.id
//! matches a target is linked, including nodes that appear mid-share (apps
//! that open a second stream, restart playback, etc). 'system-exclude-self'
//! links every playback node whose PID is NOT in our own process tree.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use pipewire as pw;
use pw::{properties::properties, spa};
use spa::pod::Pod;

use crate::{AudioApp, Capabilities, CHANNELS, FRAME_SAMPLES_PER_CH, SAMPLE_RATE};

const MEDIA_CLASS_PLAYBACK: &str = "Stream/Output/Audio";

#[derive(Clone)]
pub enum Mode {
  /// Capture only playback nodes owned by these PIDs.
  Include(HashSet<u32>),
  /// Capture every playback node except those owned by these PIDs.
  /// With an empty set this is whole-system capture - done by linking app
  /// nodes rather than tapping a device sink's monitor, because hardware
  /// monitors aren't reliable everywhere (e.g. S/PDIF sinks).
  Exclude(HashSet<u32>),
}

pub fn parse_mode(mode: &str, targets: Option<&[String]>) -> Result<Mode, String> {
  match mode {
    "app" => {
      let pids: HashSet<u32> = targets
        .unwrap_or(&[])
        .iter()
        .filter_map(|t| t.parse().ok())
        .collect();
      if pids.is_empty() {
        return Err("per-app capture needs at least one target pid".into());
      }
      Ok(Mode::Include(pids))
    }
    "system-exclude-self" => Ok(Mode::Exclude(our_process_tree())),
    "system" => Ok(Mode::Exclude(HashSet::new())),
    other => Err(format!("unknown capture mode '{other}'")),
  }
}

// ─── Process tree ────────────────────────────────────────────────

fn ppid_of(pid: u32) -> Option<u32> {
  let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
  // Field 4 (ppid) sits after the parenthesized comm, which may itself
  // contain spaces/parens - split after the LAST ')'.
  let rest = &stat[stat.rfind(')')? + 1..];
  rest.split_whitespace().nth(1)?.parse().ok()
}

/// PIDs of the whole app: the Electron main process (our parent - this code
/// runs in a utilityProcess forked from main) and all its descendants,
/// including renderers and Chromium's audio service.
pub fn our_process_tree() -> HashSet<u32> {
  let self_pid = std::process::id();
  let root = ppid_of(self_pid).unwrap_or(self_pid);

  let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
  if let Ok(entries) = std::fs::read_dir("/proc") {
    for entry in entries.flatten() {
      if let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) {
        if let Some(ppid) = ppid_of(pid) {
          children.entry(ppid).or_default().push(pid);
        }
      }
    }
  }

  let mut tree = HashSet::from([root]);
  let mut queue = vec![root];
  while let Some(pid) = queue.pop() {
    for &child in children.get(&pid).into_iter().flatten() {
      if tree.insert(child) {
        queue.push(child);
      }
    }
  }
  tree
}

// ─── Capabilities / app enumeration ──────────────────────────────

fn connect() -> Result<
  (
    pw::main_loop::MainLoopRc,
    pw::context::ContextRc,
    pw::core::CoreRc,
  ),
  pw::Error,
> {
  pw::init();
  let mainloop = pw::main_loop::MainLoopRc::new(None)?;
  let context = pw::context::ContextRc::new(&mainloop, None)?;
  let core = context.connect_rc(None)?;
  Ok((mainloop, context, core))
}

/// Process pending server events until the sync round-trip completes.
fn roundtrip(mainloop: &pw::main_loop::MainLoopRc, core: &pw::core::CoreRc) {
  let done = Rc::new(std::cell::Cell::new(false));
  let done_clone = done.clone();
  let loop_clone = mainloop.clone();
  let pending = match core.sync(0) {
    Ok(p) => p,
    Err(_) => return,
  };
  let _listener = core
    .add_listener_local()
    .done(move |id, seq| {
      if id == pw::core::PW_ID_CORE && seq == pending {
        done_clone.set(true);
        loop_clone.quit();
      }
    })
    .register();
  while !done.get() {
    mainloop.run();
  }
}

pub fn capabilities() -> Capabilities {
  let available = connect().is_ok();
  Capabilities {
    backend: if available { "pipewire".into() } else { "none".into() },
    per_app: available,
    exclude_self: available,
    system: available,
  }
}

/// Registry *global* props are a subset of full object props: nodes don't
/// carry a pid there, but Client globals expose the server-verified
/// `pipewire.sec.pid`. Nodes reference their owning connection via
/// `client.id`, so client-map + node join gives node -> pid without binding
/// any objects.
fn client_pid(props: &spa::utils::dict::DictRef) -> Option<u32> {
  props.get("pipewire.sec.pid").and_then(|p| p.parse().ok())
}

pub fn list_apps() -> Result<Vec<AudioApp>, String> {
  let (mainloop, _context, core) = connect().map_err(|e| e.to_string())?;
  let registry = core.get_registry().map_err(|e| e.to_string())?;

  struct Scan {
    clients: HashMap<u32, u32>,             // client global id -> pid
    nodes: Vec<(u32, String)>,              // (client id, display name)
  }
  let scan = Rc::new(RefCell::new(Scan { clients: HashMap::new(), nodes: Vec::new() }));
  let scan_clone = scan.clone();
  let _listener = registry
    .add_listener_local()
    .global(move |global| {
      let Some(props) = global.props else { return };
      let mut scan = scan_clone.borrow_mut();
      match global.type_ {
        pw::types::ObjectType::Client => {
          if let Some(pid) = client_pid(props) {
            scan.clients.insert(global.id, pid);
          }
        }
        pw::types::ObjectType::Node => {
          if props.get("media.class") != Some(MEDIA_CLASS_PLAYBACK) {
            return;
          }
          let Some(client_id) = props.get("client.id").and_then(|c| c.parse::<u32>().ok())
          else {
            return;
          };
          let name = props
            .get("application.name")
            .or_else(|| props.get("node.name"))
            .unwrap_or("Unknown app")
            .to_string();
          scan.nodes.push((client_id, name));
        }
        _ => {}
      }
    })
    .register();

  roundtrip(&mainloop, &core);

  let ours = our_process_tree();
  let scan = scan.borrow();
  // pid -> app, aggregating multi-stream apps into one row
  let mut apps: HashMap<u32, AudioApp> = HashMap::new();
  for (client_id, name) in &scan.nodes {
    let Some(&pid) = scan.clients.get(client_id) else { continue };
    if ours.contains(&pid) {
      continue;
    }
    apps.entry(pid).or_insert(AudioApp {
      id: pid.to_string(),
      name: name.clone(),
      pid: Some(pid),
      binary: None,
    });
  }
  let mut result: Vec<AudioApp> = apps.into_values().collect();
  result.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
  Ok(result)
}

// ─── Capture session ─────────────────────────────────────────────

struct PortInfo {
  global_id: u32,
  channel: String,
}

#[derive(Default)]
struct LinkState {
  /// Client global id -> server-verified pid (pipewire.sec.pid).
  client_pids: HashMap<u32, u32>,
  /// Our null sink's node global id (identified by node.name).
  sink_node: Option<u32>,
  /// Our sink's input ports: channel name -> port global id.
  sink_ports: HashMap<String, u32>,
  /// Candidate app playback nodes: node global id -> pid.
  app_nodes: HashMap<u32, u32>,
  /// Output ports of candidate nodes: node global id -> ports.
  app_ports: HashMap<u32, Vec<PortInfo>>,
  /// Live link proxies keyed by (output port, input port). Dropping a proxy
  /// releases our ref; the server prunes links itself when a port dies, and
  /// everything else dies with our connection at session end.
  links: HashMap<(u32, u32), pw::link::Link>,
}

fn wants_node(mode: &Mode, pid: u32) -> bool {
  match mode {
    Mode::Include(pids) => pids.contains(&pid),
    Mode::Exclude(pids) => !pids.contains(&pid),
  }
}

/// Map an app output port to our sink's input port(s). Stereo channels map
/// 1:1, mono feeds both sides, anything else falls back to FL/FR by AUX index.
fn matching_sink_channels(channel: &str) -> &'static [&'static str] {
  match channel {
    "FL" | "AUX0" => &["FL"],
    "FR" | "AUX1" => &["FR"],
    "MONO" => &["FL", "FR"],
    _ => &[],
  }
}

fn link_ports(core: &pw::core::CoreRc, state: &mut LinkState, node_id: u32) {
  let Some(&sink_node) = state.sink_node.as_ref() else { return };
  if state.sink_ports.is_empty() {
    return;
  }
  let Some(ports) = state.app_ports.get(&node_id) else { return };

  let mut new_links = Vec::new();
  for port in ports {
    for channel in matching_sink_channels(&port.channel) {
      let Some(&sink_port) = state.sink_ports.get(*channel) else { continue };
      let key = (port.global_id, sink_port);
      if state.links.contains_key(&key) {
        continue;
      }
      let link = core.create_object::<pw::link::Link>(
        "link-factory",
        &properties! {
          "link.output.node" => node_id.to_string(),
          "link.output.port" => port.global_id.to_string(),
          "link.input.node" => sink_node.to_string(),
          "link.input.port" => sink_port.to_string(),
        },
      );
      match link {
        Ok(link) => {
          new_links.push((key, link));
        }
        Err(err) => eprintln!("[audio-capture] link {key:?} failed: {err}"),
      }
    }
  }
  for (key, link) in new_links {
    state.links.insert(key, link);
  }
}

fn relink_all(core: &pw::core::CoreRc, state: &mut LinkState) {
  let nodes: Vec<u32> = state.app_ports.keys().copied().collect();
  for node_id in nodes {
    link_ports(core, state, node_id);
  }
}

pub fn spawn(
  mode: Mode,
  stop_flag: Arc<AtomicBool>,
  emit_frame: impl Fn(Vec<u8>) + Send + 'static,
  emit_error: impl Fn(String) + Send + 'static,
) -> thread::JoinHandle<()> {
  thread::spawn(move || {
    if let Err(err) = run_capture(mode, stop_flag, emit_frame, &emit_error) {
      emit_error(err);
    }
  })
}

struct StreamData {
  /// Sample accumulator so uneven graph quanta still emit exact 10ms frames.
  pending: Vec<f32>,
}

fn run_capture(
  mode: Mode,
  stop_flag: Arc<AtomicBool>,
  emit_frame: impl Fn(Vec<u8>) + Send + 'static,
  emit_error: &(impl Fn(String) + Send + 'static),
) -> Result<(), String> {
  let (mainloop, _context, core) = connect().map_err(|e| format!("pipewire connect: {e}"))?;

  let sink_name = format!("voip-screenshare-{}", std::process::id());

  // 1. Virtual sink for the share. Apps get linked into it, the capture
  //    stream records its monitor.
  let _sink_proxy = core
    .create_object::<pw::node::Node>(
      "adapter",
      &properties! {
        "factory.name" => "support.null-audio-sink",
        "node.name" => sink_name.as_str(),
        "node.description" => "Screenshare audio (do not select)",
        "media.class" => "Audio/Sink",
        "node.virtual" => "true",
        "audio.position" => "[ FL FR ]",
        "monitor.channel-volumes" => "true"
      },
    )
    .map_err(|e| format!("null sink create: {e}"))?;

  // 2. Registry listener maintaining app-node -> sink links.
  let state = Rc::new(RefCell::new(LinkState::default()));
  let registry = core.get_registry().map_err(|e| e.to_string())?;
  let _registry_listener = {
    let state_add = state.clone();
    let state_rm = state.clone();
    let core_add = core.clone();
    let mode_add = mode.clone();
    let sink_name_add = sink_name.clone();
    registry
      .add_listener_local()
        .global(move |global| {
          let Some(props) = global.props else { return };
          let mut st = state_add.borrow_mut();
          match global.type_ {
            pw::types::ObjectType::Client => {
              if let Some(pid) = client_pid(props) {
                st.client_pids.insert(global.id, pid);
              }
            }
            pw::types::ObjectType::Node => {
              if props.get("node.name") == Some(sink_name_add.as_str()) {
                st.sink_node = Some(global.id);
              } else if props.get("media.class") == Some(MEDIA_CLASS_PLAYBACK) {
                // Client globals always precede their nodes, so the pid is
                // resolvable by the time a node shows up.
                let Some(pid) = props
                  .get("client.id")
                  .and_then(|c| c.parse::<u32>().ok())
                  .and_then(|c| st.client_pids.get(&c).copied())
                else {
                  return;
                };
                if wants_node(&mode_add, pid) {
                  st.app_nodes.insert(global.id, pid);
                }
              }
            }
            pw::types::ObjectType::Port => {
              let Some(node_id) = props.get("node.id").and_then(|n| n.parse::<u32>().ok())
              else {
                return;
              };
              let direction = props.get("port.direction").unwrap_or("");
              let channel = props.get("audio.channel").unwrap_or("UNK").to_string();
              if Some(node_id) == st.sink_node && direction == "in" {
                st.sink_ports.insert(channel, global.id);
                relink_all(&core_add, &mut st);
              } else if st.app_nodes.contains_key(&node_id) && direction == "out" {
                st.app_ports
                  .entry(node_id)
                  .or_default()
                  .push(PortInfo { global_id: global.id, channel });
                link_ports(&core_add, &mut st, node_id);
              }
            }
            _ => {}
          }
        })
        .global_remove(move |id| {
          let mut st = state_rm.borrow_mut();
          // The server already removed any links touching a dead port/node;
          // just drop our bookkeeping (and proxies) for them.
          if st.app_nodes.remove(&id).is_some() {
            if let Some(ports) = st.app_ports.remove(&id) {
              for port in ports {
                st.links.retain(|&(out_port, _), _| out_port != port.global_id);
              }
            }
          } else {
            st.links.retain(|&(out_port, in_port), _| out_port != id && in_port != id);
            st.sink_ports.retain(|_, &mut port_id| port_id != id);
          }
        })
        .register()
  };

  // 3. Capture stream on our virtual sink's monitor.
  let stream_props = properties! {
    *pw::keys::MEDIA_TYPE => "Audio",
    *pw::keys::MEDIA_CATEGORY => "Capture",
    *pw::keys::MEDIA_ROLE => "Screen",
    *pw::keys::STREAM_CAPTURE_SINK => "true",
    *pw::keys::NODE_NAME => "voip-screenshare-capture",
    *pw::keys::TARGET_OBJECT => sink_name.as_str()
  };

  let stream = pw::stream::StreamBox::new(&core, "screenshare-audio", stream_props)
    .map_err(|e| format!("stream create: {e}"))?;

  let data = StreamData {
    pending: Vec::with_capacity(FRAME_SAMPLES_PER_CH * CHANNELS * 4),
  };
  let mainloop_err = mainloop.clone();
  let emit_error_stream = {
    let mainloop = mainloop.clone();
    let msg: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));
    (msg.clone(), move |m: String| {
      *msg.borrow_mut() = Some(m);
      mainloop.quit();
    })
  };
  let (stream_error, set_stream_error) = emit_error_stream;

  let _stream_listener = stream
    .add_local_listener_with_user_data(data)
    .state_changed(move |_stream, _data, _old, new| {
      if let pw::stream::StreamState::Error(e) = new {
        set_stream_error(format!("stream error: {e}"));
        let _ = &mainloop_err;
      }
    })
    .process(move |stream, data| {
      let Some(mut buffer) = stream.dequeue_buffer() else { return };
      let datas = buffer.datas_mut();
      if datas.is_empty() {
        return;
      }
      let d = &mut datas[0];
      let offset = d.chunk().offset() as usize;
      let size = d.chunk().size() as usize;
      let Some(bytes) = d.data() else { return };
      let end = (offset + size).min(bytes.len());
      let valid = &bytes[offset.min(end)..end];

      // Interleaved f32le (negotiated below); accumulate and emit 10ms frames
      for sample in valid.chunks_exact(4) {
        data
          .pending
          .push(f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]));
      }
      let frame_len = FRAME_SAMPLES_PER_CH * CHANNELS;
      while data.pending.len() >= frame_len {
        let frame: Vec<u8> = data.pending[..frame_len]
          .iter()
          .flat_map(|s| s.to_le_bytes())
          .collect();
        data.pending.drain(..frame_len);
        emit_frame(frame);
      }
    })
    .register()
    .map_err(|e| format!("stream listener: {e}"))?;

  // Fixed wire format: the stream's adapter resamples/remixes the graph to it
  let mut audio_info = spa::param::audio::AudioInfoRaw::new();
  audio_info.set_format(spa::param::audio::AudioFormat::F32LE);
  audio_info.set_rate(SAMPLE_RATE);
  audio_info.set_channels(CHANNELS as u32);
  let mut position = [0; spa::param::audio::MAX_CHANNELS];
  position[0] = libspa_sys::SPA_AUDIO_CHANNEL_FL;
  position[1] = libspa_sys::SPA_AUDIO_CHANNEL_FR;
  audio_info.set_position(position);
  let values: Vec<u8> = pw::spa::pod::serialize::PodSerializer::serialize(
    std::io::Cursor::new(Vec::new()),
    &pw::spa::pod::Value::Object(pw::spa::pod::Object {
      type_: pw::spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
      id: pw::spa::param::ParamType::EnumFormat.as_raw(),
      properties: audio_info.into(),
    }),
  )
  .map_err(|e| format!("format pod: {e:?}"))?
  .0
  .into_inner();
  let mut params = [Pod::from_bytes(&values).ok_or("format pod parse")?];

  stream
    .connect(
      spa::utils::Direction::Input,
      None,
      pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
      &mut params,
    )
    .map_err(|e| format!("stream connect: {e}"))?;

  // 4. Stop polling: quit the loop when JS asks us to stop.
  let timer = {
    let mainloop_timer = mainloop.clone();
    let stop = stop_flag.clone();
    mainloop.loop_().add_timer(move |_| {
      if stop.load(Ordering::SeqCst) {
        mainloop_timer.quit();
      }
    })
  };
  timer
    .update_timer(Some(Duration::from_millis(50)), Some(Duration::from_millis(50)))
    .into_result()
    .map_err(|e| format!("timer: {e}"))?;

  mainloop.run();

  // Surface an in-loop stream error (if that's why we quit).
  if let Some(err) = stream_error.borrow_mut().take() {
    if !stop_flag.load(Ordering::SeqCst) {
      emit_error(err);
    }
  }

  let _ = stream.disconnect();
  state.borrow_mut().links.clear();
  Ok(())
}
