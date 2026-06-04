// ─── Imports ────────────────────────────────────────────────────
import { Device } from 'mediasoup-client';
import { io } from 'socket.io-client';

// ─── Config ─────────────────────────────────────────────────────
const SERVER_URL = 'http://127.0.0.1:3000';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// ─── Mediasoup state ────────────────────────────────────────────
let device;               // mediasoup Device
let socket;               // Socket.IO connection
let producerTransport;    // send transport (local → server)
let consumerTransport;    // receive transport (server → local)
let producers = [];       // local producers
let currentChannel = null;

// ─── DOM references ─────────────────────────────────────────────
const statusEl = document.getElementById('status');
const videoGrid = document.getElementById('video-grid');
const btnPublish = document.getElementById('btn-publish');
const btnSubscribe = document.getElementById('btn-subscribe');
const btnJoin = document.getElementById('btn-join');
const channelInput = document.getElementById('channel-input');
const channelBadge = document.getElementById('channel-badge');

// ─── Helpers ────────────────────────────────────────────────────
function setStatus(msg) {
  statusEl.textContent = `Status: ${msg}`;
  console.log(`[Status] ${msg}`);
}

// ─── Add video to grid ──────────────────────────────────────────
function addVideo(stream, label) {
  const container = document.createElement('div');
  container.className = 'video-container';

  const video = document.createElement('video');
  video.srcObject = stream;
  video.autoplay = true;
  video.playsInline = true;
  if (label === 'Local') {
    video.muted = true;
  }

  const labelEl = document.createElement('div');
  labelEl.className = 'video-label';
  labelEl.textContent = label;

  container.appendChild(video);
  container.appendChild(labelEl);
  videoGrid.appendChild(container);

  return video;
}

// ─── Cleanup media state ────────────────────────────────────────
function resetMediaState() {
  if (producerTransport) {
    producerTransport.close();
    producerTransport = null;
  }
  if (consumerTransport) {
    consumerTransport.close();
    consumerTransport = null;
  }
  producers = [];
  device = null;
  videoGrid.innerHTML = '';
}

// ─── Connect to signaling server ────────────────────────────────
function connect() {
  socket = io(SERVER_URL);

  socket.on('connect', () => {
    setStatus('Connected to server');
  });

  socket.on('disconnect', () => {
    setStatus('Disconnected from server');
    currentChannel = null;
    channelBadge.textContent = 'No channel joined';
    btnPublish.disabled = true;
    btnSubscribe.disabled = true;
    btnJoin.disabled = false;
    resetMediaState();
  });

  socket.on('newProducer', ({ producerId, kind }) => {
    console.log(`New producer available in channel: ${producerId} (${kind})`);
    consumeProducer(producerId, kind);
  });
}

// ─── Join channel ───────────────────────────────────────────────
async function joinChannel() {
  const channelId = channelInput.value.trim();
  if (!channelId) {
    setStatus('Please enter a channel name');
    return;
  }

  btnJoin.disabled = true;
  setStatus(`Joining channel "${channelId}"...`);

  // Reset media state when switching channels
  resetMediaState();
  btnPublish.disabled = true;
  btnSubscribe.disabled = true;

  const result = await new Promise((resolve) => {
    socket.emit('joinChannel', { channelId }, resolve);
  });

  if (result?.error) {
    setStatus(`Error joining channel: ${result.error}`);
    btnJoin.disabled = false;
    return;
  }

  currentChannel = result.channelId;
  channelBadge.textContent = `Channel: ${currentChannel}`;
  btnPublish.disabled = false;
  btnSubscribe.disabled = false;
  btnJoin.disabled = false;
  setStatus(`Joined channel "${currentChannel}"`);
}

// ─── Load mediasoup Device ──────────────────────────────────────
async function loadDevice() {
  const rtpCapabilities = await new Promise((resolve) => {
    socket.emit('getRouterRtpCapabilities', resolve);
  });

  if (rtpCapabilities?.error) {
    throw new Error(rtpCapabilities.error);
  }

  device = new Device();
  await device.load({ routerRtpCapabilities: rtpCapabilities });
  setStatus('Device loaded');
}

// ─── Publish: send local media ──────────────────────────────────
async function publish() {
  if (!currentChannel) {
    setStatus('Please join a channel first');
    return;
  }

  btnPublish.disabled = true;

  if (!device) {
    await loadDevice();
  }

  // Create producer transport
  const transportParams = await new Promise((resolve) => {
    socket.emit('createProducerTransport', resolve);
  });

  if (transportParams.error) {
    setStatus(`Error: ${transportParams.error}`);
    btnPublish.disabled = false;
    return;
  }

  producerTransport = device.createSendTransport({ ...transportParams, iceServers: ICE_SERVERS });

  producerTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
    socket.emit('connectProducerTransport', { dtlsParameters }, (response) => {
      if (response?.error) {
        errback(new Error(response.error));
      } else {
        callback();
      }
    });
  });

  producerTransport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
    socket.emit('produce', { kind, rtpParameters }, (response) => {
      if (response?.error) {
        errback(new Error(response.error));
      } else {
        callback({ id: response.id });
      }
    });
  });

  // Get user media
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    console.error('getUserMedia (video+audio) failed:', err.name, err.message);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err2) {
      console.error('getUserMedia (video only) failed:', err2.name, err2.message);
      setStatus(`Failed to get media devices: ${err2.name} - ${err2.message}`);
      btnPublish.disabled = false;
      return;
    }
  }

  addVideo(stream, 'Local');

  // Produce each track
  for (const track of stream.getTracks()) {
    const producer = await producerTransport.produce({ track });
    producers.push(producer);
    console.log(`Producing ${track.kind} [id:${producer.id}]`);
  }

  setStatus('Publishing media');
}

// ─── Subscribe: receive remote media ────────────────────────────
async function subscribe() {
  if (!currentChannel) {
    setStatus('Please join a channel first');
    return;
  }

  btnSubscribe.disabled = true;

  if (!device) {
    await loadDevice();
  }

  // Create consumer transport if not exists
  if (!consumerTransport) {
    const transportParams = await new Promise((resolve) => {
      socket.emit('createConsumerTransport', resolve);
    });

    if (transportParams.error) {
      setStatus(`Error: ${transportParams.error}`);
      btnSubscribe.disabled = false;
      return;
    }

    consumerTransport = device.createRecvTransport({ ...transportParams, iceServers: ICE_SERVERS });

    consumerTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      socket.emit('connectConsumerTransport', { dtlsParameters }, (response) => {
        if (response?.error) {
          errback(new Error(response.error));
        } else {
          callback();
        }
      });
    });
  }

  // Get existing producers from the server (channel-scoped)
  const existingProducers = await new Promise((resolve) => {
    socket.emit('getProducers', resolve);
  });

  if (existingProducers.length === 0) {
    setStatus('No remote producers available yet');
    btnSubscribe.disabled = false;
    return;
  }

  for (const { producerId, kind } of existingProducers) {
    await consumeProducer(producerId, kind);
  }

  setStatus('Subscribed to remote streams');
}

// ─── Consume a remote producer ──────────────────────────────────
async function consumeProducer(producerId, kind) {
  if (!consumerTransport) {
    // Auto-create consumer transport if needed
    if (!device) {
      await loadDevice();
    }

    const transportParams = await new Promise((resolve) => {
      socket.emit('createConsumerTransport', resolve);
    });

    if (transportParams.error) {
      console.error('Failed to create consumer transport:', transportParams.error);
      return;
    }

    consumerTransport = device.createRecvTransport({ ...transportParams, iceServers: ICE_SERVERS });

    consumerTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      socket.emit('connectConsumerTransport', { dtlsParameters }, (response) => {
        if (response?.error) {
          errback(new Error(response.error));
        } else {
          callback();
        }
      });
    });
  }

  const consumerParams = await new Promise((resolve) => {
    socket.emit(
      'consume',
      { producerId, rtpCapabilities: device.rtpCapabilities },
      resolve
    );
  });

  if (consumerParams.error) {
    console.error('Cannot consume:', consumerParams.error);
    return;
  }

  const consumer = await consumerTransport.consume({
    id: consumerParams.id,
    producerId: consumerParams.producerId,
    kind: consumerParams.kind,
    rtpParameters: consumerParams.rtpParameters,
  });

  const stream = new MediaStream([consumer.track]);
  addVideo(stream, `Remote (${kind})`);

  // Resume the consumer on the server
  const resumeResult = await new Promise((resolve) => {
    socket.emit('resumeConsumer', { consumerId: consumer.id }, resolve);
  });

  if (resumeResult?.error) {
    console.error('Failed to resume consumer:', resumeResult.error);
  } else {
    console.log(`Consumer resumed [id:${consumer.id}]`);
  }

  console.log(`Consuming ${kind} [id:${consumer.id}]`);
}

// ─── Event listeners ────────────────────────────────────────────
btnJoin.addEventListener('click', joinChannel);
channelInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinChannel(); });
btnPublish.addEventListener('click', publish);
btnSubscribe.addEventListener('click', subscribe);

// ─── Initialize ─────────────────────────────────────────────────
connect();
