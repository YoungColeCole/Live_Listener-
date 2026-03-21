const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const PORT = process.env.PORT || 8080;

// ─── Cloudflare R2 client ────────────────────────────────────────────────────
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
const R2_BUCKET = process.env.R2_BUCKET_NAME || 'live-listener-audio';

// ─── In-memory state ─────────────────────────────────────────────────────────
const senders   = new Map(); // ws → { id, name, connectedAt, lastHeartbeat, sampleRate, quality, mode }
const receivers = new Map(); // ws → { selectedSender, lastHeartbeat, qualityPreference }

// Audio buffers for R2 upload: Map<senderName, { chunks: Buffer[], startTime: number, sampleRate: number }>
const audioBuffers = new Map();
const CHUNK_DURATION_MS = 60_000; // upload one file per minute per device

// Ultimate Recording Mode state
let ultimateModeActive = false;
let ultimateModeActivatedAt = null;

// Logs per device
const deviceLogs = new Map();
const MAX_LOGS_PER_DEVICE = 200;

// Stats
let stats = {
  totalConnections: 0,
  activeSenders: 0,
  activeReceivers: 0,
  bytesRelayed: 0,
  bytesUploaded: 0,
  startTime: Date.now(),
};

// ─── WAV header helper ───────────────────────────────────────────────────────
function buildWavHeader(dataLength, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const buf = Buffer.alloc(44);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLength, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);        // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLength, 40);
  return buf;
}

// ─── R2 upload helper ────────────────────────────────────────────────────────
async function uploadToR2(senderName, sampleRate, pcmChunks, startTime) {
  try {
    const totalBytes = pcmChunks.reduce((s, c) => s + c.length, 0);
    if (totalBytes === 0) return;

    const pcmData = Buffer.concat(pcmChunks);
    const wavHeader = buildWavHeader(pcmData.length, sampleRate);
    const wavData = Buffer.concat([wavHeader, pcmData]);

    const date = new Date(startTime);
    const dateStr = date.toISOString().slice(0, 10);                         // YYYY-MM-DD
    const timeStr = date.toISOString().slice(11, 19).replace(/:/g, '-');     // HH-MM-SS
    const safeName = senderName.replace(/[^a-zA-Z0-9_\-]/g, '_');
    const key = `${safeName}/${dateStr}/${timeStr}.wav`;

    await r2.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: wavData,
      ContentType: 'audio/wav',
    }));

    stats.bytesUploaded += wavData.length;
    console.log(`[R2] Uploaded ${key} (${(wavData.length / 1024).toFixed(1)} KB)`);
  } catch (err) {
    console.error(`[R2] Upload failed for ${senderName}: ${err.message}`);
  }
}

// ─── Flush a device's audio buffer to R2 ────────────────────────────────────
async function flushBuffer(senderName) {
  const buf = audioBuffers.get(senderName);
  if (!buf || buf.chunks.length === 0) return;

  const { chunks, startTime, sampleRate } = buf;
  audioBuffers.set(senderName, { chunks: [], startTime: Date.now(), sampleRate });
  await uploadToR2(senderName, sampleRate, chunks, startTime);
}

// ─── Periodic flush: every minute, upload accumulated audio ─────────────────
setInterval(async () => {
  if (!ultimateModeActive) return;
  for (const senderName of audioBuffers.keys()) {
    await flushBuffer(senderName);
  }
}, CHUNK_DURATION_MS);

// ─── Express dashboard ───────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const s = uptime % 60;
  const modeStatus = ultimateModeActive
    ? `<span style="color:#4CAF50">● ACTIVE since ${new Date(ultimateModeActivatedAt).toUTCString()}</span>`
    : `<span style="color:#f44336">● INACTIVE</span>`;

  res.send(`<!DOCTYPE html><html><head><title>Audio Relay</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{font-family:sans-serif;max-width:800px;margin:50px auto;padding:20px;background:#0f0f0f;color:#e0e0e0}
    h1{color:#4CAF50;text-align:center}.status{background:#1a1a1a;padding:20px;border-radius:10px;margin:20px 0;border-left:4px solid #4CAF50}
    .stat{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #333}.stat:last-child{border-bottom:none}
    .label{color:#888}.value{color:#4CAF50;font-weight:bold;font-size:1.2em}</style>
    <script>setInterval(()=>location.reload(),5000)</script></head><body>
    <h1>🎙️ Audio Relay Server</h1>
    <div class="status">
      <div class="stat"><span class="label">Status:</span><span class="value">● ONLINE</span></div>
      <div class="stat"><span class="label">Uptime:</span><span class="value">${h}h ${m}m ${s}s</span></div>
      <div class="stat"><span class="label">Ultimate Recording Mode:</span><span>${modeStatus}</span></div>
      <div class="stat"><span class="label">Active Senders:</span><span class="value">${stats.activeSenders}</span></div>
      <div class="stat"><span class="label">Active Receivers:</span><span class="value">${stats.activeReceivers}</span></div>
      <div class="stat"><span class="label">Data Relayed:</span><span class="value">${(stats.bytesRelayed/1048576).toFixed(2)} MB</span></div>
      <div class="stat"><span class="label">Data Uploaded to R2:</span><span class="value">${(stats.bytesUploaded/1048576).toFixed(2)} MB</span></div>
    </div></body></html>`);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    senders: stats.activeSenders,
    receivers: stats.activeReceivers,
    ultimateModeActive,
    uptime: Date.now() - stats.startTime,
  });
});

// ─── WebSocket server ─────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  stats.totalConnections++;
  console.log(`[${new Date().toISOString()}] New connection from ${req.socket.remoteAddress}`);

  let clientType = null;
  let clientId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  ws.send(JSON.stringify({ type: 'welcome', message: 'Connected to relay server', clientId }));

  // Send current ultimate mode state immediately
  ws.send(JSON.stringify({ type: 'ultimateModeState', active: ultimateModeActive }));

  ws.on('message', (data) => {
    try {
      // ── Text / control messages ──────────────────────────────────────────
      if (data.length < 2000) {
        try {
          const message = JSON.parse(data.toString());

          // ── identify ──────────────────────────────────────────────────────
          if (message.type === 'identify') {
            clientType = message.role;

            if (clientType === 'sender') {
              const deviceName = message.deviceName || `Device-${clientId.substr(0, 6)}`;

              // Remove stale connection with same name
              senders.forEach((info, oldWs) => {
                if (info.name === deviceName && oldWs !== ws) {
                  senders.delete(oldWs);
                  try { oldWs.close(); } catch {}
                }
              });

              const sampleRate = message.sampleRate || 24000;
              const quality    = message.quality    || 'medium';
              const mode       = message.mode       || 'always-on';

              senders.set(ws, {
                id: clientId, name: deviceName, connectedAt: Date.now(),
                lastHeartbeat: Date.now(), sampleRate, quality, mode,
              });
              stats.activeSenders = senders.size;
              console.log(`[SENDER] connected: ${deviceName} (mode=${mode})`);

              ws.send(JSON.stringify({ type: 'identified', role: 'sender', senderId: clientId, deviceName }));

              // Tell sender current ultimate mode state
              ws.send(JSON.stringify({ type: 'ultimateModeState', active: ultimateModeActive }));

              broadcastSenderList();

              // If receivers are waiting, tell sender to stream (unless it's screen-off-only — it will decide itself)
              if (receivers.size > 0) {
                ws.send(JSON.stringify({ type: 'startStreaming' }));
              }

              // Init audio buffer for this device
              if (!audioBuffers.has(deviceName)) {
                audioBuffers.set(deviceName, { chunks: [], startTime: Date.now(), sampleRate });
              }

            } else if (clientType === 'receiver') {
              receivers.set(ws, {
                selectedSender: null, connectedAt: Date.now(),
                lastHeartbeat: Date.now(), qualityPreference: message.qualityPreference || 'medium',
              });
              stats.activeReceivers = receivers.size;
              console.log(`[RECEIVER] connected (id=${clientId})`);

              ws.send(JSON.stringify({ type: 'identified', role: 'receiver' }));
              ws.send(JSON.stringify({ type: 'ultimateModeState', active: ultimateModeActive }));
              sendSenderList(ws);
              broadcastStartStreaming();
            }
            return;
          }

          // ── selectSender ─────────────────────────────────────────────────
          if (message.type === 'selectSender' && clientType === 'receiver') {
            const info = receivers.get(ws);
            if (info) {
              info.selectedSender = message.senderId;
              console.log(`[RECEIVER] selected sender: ${message.senderId || 'ALL'}`);
              ws.send(JSON.stringify({ type: 'senderSelected', senderId: message.senderId }));
            }
            return;
          }

          // ── changeQuality ────────────────────────────────────────────────
          if (message.type === 'changeQuality' && clientType === 'receiver') {
            const quality = message.quality || 'medium';
            senders.forEach((info, sWs) => {
              if (sWs.readyState === 1) {
                try { sWs.send(JSON.stringify({ type: 'changeQuality', quality })); } catch {}
              }
            });
            ws.send(JSON.stringify({ type: 'qualityChanged', quality }));
            return;
          }

          // ── ping ─────────────────────────────────────────────────────────
          if (message.type === 'ping') {
            if (clientType === 'sender') {
              const i = senders.get(ws); if (i) i.lastHeartbeat = Date.now();
            } else {
              const i = receivers.get(ws); if (i) i.lastHeartbeat = Date.now();
            }
            ws.send(JSON.stringify({ type: 'pong' }));
            return;
          }

          // ── getLogs ──────────────────────────────────────────────────────
          if (message.type === 'getLogs' && clientType === 'receiver') {
            const deviceName = message.deviceName || null;
            if (deviceName && deviceLogs.has(deviceName)) {
              ws.send(JSON.stringify({ type: 'logs', deviceName, logs: deviceLogs.get(deviceName) }));
            } else if (!deviceName) {
              const all = {};
              deviceLogs.forEach((l, d) => { all[d] = l; });
              ws.send(JSON.stringify({ type: 'logs', allLogs: all }));
            } else {
              ws.send(JSON.stringify({ type: 'logs', deviceName, logs: [] }));
            }
            return;
          }

          // ── log from sender ───────────────────────────────────────────────
          if (message.type === 'log' && clientType === 'sender') {
            const deviceName = message.deviceName || 'Unknown';
            if (!deviceLogs.has(deviceName)) deviceLogs.set(deviceName, []);
            const logs = deviceLogs.get(deviceName);
            logs.push({ timestamp: message.timestamp || Date.now(), level: message.level || 'info', message: message.message || '' });
            if (logs.length > MAX_LOGS_PER_DEVICE) logs.shift();
            console.log(`[LOG] ${deviceName} [${message.level}]: ${message.message}`);
            return;
          }

          // ── activateUltimateMode (from receiver) ─────────────────────────
          if (message.type === 'activateUltimateMode' && clientType === 'receiver') {
            ultimateModeActive = true;
            ultimateModeActivatedAt = Date.now();
            console.log(`[ULTIMATE] Mode ACTIVATED`);

            // Reset all audio buffers
            senders.forEach((info) => {
              audioBuffers.set(info.name, { chunks: [], startTime: Date.now(), sampleRate: info.sampleRate });
            });

            // Broadcast to all senders + receivers
            const msg = JSON.stringify({ type: 'ultimateModeState', active: true });
            senders.forEach((_, sWs)   => { try { sWs.send(msg); } catch {} });
            receivers.forEach((_, rWs) => { try { rWs.send(msg); } catch {} });
            return;
          }

          // ── deactivateUltimateMode (from receiver) ───────────────────────
          if (message.type === 'deactivateUltimateMode' && clientType === 'receiver') {
            // Flush remaining audio before deactivating
            (async () => {
              for (const name of audioBuffers.keys()) await flushBuffer(name);
              ultimateModeActive = false;
              ultimateModeActivatedAt = null;
              console.log(`[ULTIMATE] Mode DEACTIVATED`);
              const msg = JSON.stringify({ type: 'ultimateModeState', active: false });
              senders.forEach((_, sWs)   => { try { sWs.send(msg); } catch {} });
              receivers.forEach((_, rWs) => { try { rWs.send(msg); } catch {} });
            })();
            return;
          }

        } catch (e) {
          // Not JSON — fall through to audio handling
        }
      }

      // ── Binary audio data from sender ─────────────────────────────────────
      if (clientType === 'sender') {
        stats.bytesRelayed += data.length;
        const senderInfo = senders.get(ws);
        if (!senderInfo) return;

        senderInfo.lastHeartbeat = Date.now();

        // Buffer for R2 upload (ultimate mode)
        if (ultimateModeActive) {
          const buf = audioBuffers.get(senderInfo.name);
          if (buf) buf.chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        }

        // Relay to receivers
        receivers.forEach((receiverInfo, receiverWs) => {
          if (receiverWs.readyState !== 1) return;
          const shouldRelay = receiverInfo.selectedSender === null || receiverInfo.selectedSender === senderInfo.id;
          if (!shouldRelay) return;
          try {
            const header = Buffer.from(JSON.stringify({ senderId: senderInfo.id, senderName: senderInfo.name }) + '\n');
            receiverWs.send(Buffer.concat([header, Buffer.isBuffer(data) ? data : Buffer.from(data)]));
          } catch (err) {
            console.error(`Error relaying to receiver: ${err.message}`);
          }
        });
      }

    } catch (err) {
      console.error(`Error processing message: ${err.message}`);
    }
  });

  ws.on('close', () => {
    if (clientType === 'sender') {
      const info = senders.get(ws);
      // Flush remaining audio on disconnect
      if (ultimateModeActive && info) flushBuffer(info.name).catch(() => {});
      senders.delete(ws);
      stats.activeSenders = senders.size;
      console.log(`[SENDER] disconnected: ${info?.name || clientId}`);
      broadcastSenderList();
    } else if (clientType === 'receiver') {
      receivers.delete(ws);
      stats.activeReceivers = receivers.size;
      console.log(`[RECEIVER] disconnected: ${clientId}`);
      if (receivers.size === 0) broadcastStopStreaming();
    }
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error for ${clientId}: ${err.message}`);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function sendSenderList(receiverWs) {
  const list = Array.from(senders.values()).map(s => ({
    id: s.id, name: s.name, connectedAt: s.connectedAt,
    quality: s.quality || 'medium', sampleRate: s.sampleRate || 24000, mode: s.mode || 'always-on',
  }));
  try { receiverWs.send(JSON.stringify({ type: 'senderList', senders: list })); } catch {}
}

function broadcastSenderList() {
  const list = Array.from(senders.values()).map(s => ({
    id: s.id, name: s.name, connectedAt: s.connectedAt,
    quality: s.quality || 'medium', sampleRate: s.sampleRate || 24000, mode: s.mode || 'always-on',
  }));
  receivers.forEach((_, rWs) => {
    if (rWs.readyState === 1) {
      try { rWs.send(JSON.stringify({ type: 'senderList', senders: list })); } catch {}
    }
  });
}

function broadcastStartStreaming() {
  senders.forEach((info, sWs) => {
    if (sWs.readyState === 1) {
      try { sWs.send(JSON.stringify({ type: 'startStreaming' })); } catch {}
    }
  });
}

function broadcastStopStreaming() {
  senders.forEach((info, sWs) => {
    if (sWs.readyState === 1) {
      try { sWs.send(JSON.stringify({ type: 'stopStreaming' })); } catch {}
    }
  });
}

// ─── Stale connection cleanup ─────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  const timeout = 60_000;
  let changed = false;

  senders.forEach((info, ws) => {
    if (now - info.lastHeartbeat > timeout) {
      console.log(`[CLEANUP] Stale sender: ${info.name}`);
      if (ultimateModeActive) flushBuffer(info.name).catch(() => {});
      senders.delete(ws);
      try { ws.close(); } catch {}
      changed = true;
    }
  });
  if (changed) { stats.activeSenders = senders.size; broadcastSenderList(); }

  receivers.forEach((info, ws) => {
    if (now - info.lastHeartbeat > timeout) {
      console.log(`[CLEANUP] Stale receiver`);
      receivers.delete(ws);
      try { ws.close(); } catch {}
    }
  });
  stats.activeReceivers = receivers.size;
}, 30_000);

// ─── Start ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('========================================');
  console.log('🎙️  Audio Relay Server Started');
  console.log('========================================');
  console.log(`Port: ${PORT}`);
  console.log(`R2 Bucket: ${R2_BUCKET}`);
  console.log(`R2 Account: ${process.env.R2_ACCOUNT_ID || '(not set)'}`);
  console.log('========================================');
});

process.on('SIGTERM', () => {
  console.log('SIGTERM: flushing buffers and shutting down...');
  (async () => {
    for (const name of audioBuffers.keys()) await flushBuffer(name);
    server.close(() => process.exit(0));
  })();
});

