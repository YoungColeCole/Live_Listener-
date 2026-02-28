const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 8080;

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocketServer({ server });

// Store connected clients
const senders = new Map();    // Tablets sending audio: Map<ws, {id, name, connectedAt, lastHeartbeat, sampleRate, quality}>
const receivers = new Map();  // Phone receiving audio: Map<ws, {selectedSender, lastHeartbeat, qualityPreference}>

// Store logs per device (last 200 entries per device)
const deviceLogs = new Map(); // Map<deviceName, Array<{timestamp, level, message}>>
const MAX_LOGS_PER_DEVICE = 200;

// Statistics
let stats = {
  totalConnections: 0,
  activeSenders: 0,
  activeReceivers: 0,
  bytesRelayed: 0,
  startTime: Date.now()
};

// Simple web dashboard
app.get('/', (req, res) => {
  const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = uptime % 60;
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Audio Relay Server</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          max-width: 800px;
          margin: 50px auto;
          padding: 20px;
          background: #0f0f0f;
          color: #e0e0e0;
        }
        h1 { color: #4CAF50; text-align: center; }
        .status {
          background: #1a1a1a;
          padding: 20px;
          border-radius: 10px;
          margin: 20px 0;
          border-left: 4px solid #4CAF50;
        }
        .stat {
          display: flex;
          justify-content: space-between;
          padding: 10px 0;
          border-bottom: 1px solid #333;
        }
        .stat:last-child { border-bottom: none; }
        .label { color: #888; }
        .value { 
          color: #4CAF50; 
          font-weight: bold;
          font-size: 1.2em;
        }
        .online { color: #4CAF50; }
        .offline { color: #f44336; }
        .footer {
          text-align: center;
          margin-top: 30px;
          color: #666;
          font-size: 0.9em;
        }
      </style>
      <script>
        setInterval(() => location.reload(), 5000);
      </script>
    </head>
    <body>
      <h1>🎙️ Audio Relay Server</h1>
      
      <div class="status">
        <div class="stat">
          <span class="label">Server Status:</span>
          <span class="value online">● ONLINE</span>
        </div>
        <div class="stat">
          <span class="label">Uptime:</span>
          <span class="value">${hours}h ${minutes}m ${seconds}s</span>
        </div>
        <div class="stat">
          <span class="label">Active Senders (Tablets):</span>
          <span class="value">${stats.activeSenders}</span>
        </div>
        <div class="stat">
          <span class="label">Active Receivers (Phone):</span>
          <span class="value">${stats.activeReceivers}</span>
        </div>
        <div class="stat">
          <span class="label">Total Connections:</span>
          <span class="value">${stats.totalConnections}</span>
        </div>
        <div class="stat">
          <span class="label">Data Relayed:</span>
          <span class="value">${(stats.bytesRelayed / (1024 * 1024)).toFixed(2)} MB</span>
        </div>
      </div>

      <div class="footer">
        Auto-refreshes every 5 seconds
      </div>
    </body>
    </html>
  `);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    senders: stats.activeSenders,
    receivers: stats.activeReceivers,
    uptime: Date.now() - stats.startTime
  });
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  stats.totalConnections++;
  
  console.log(`[${new Date().toISOString()}] New connection from ${req.socket.remoteAddress}`);
  
  let clientType = null; // 'sender' or 'receiver'
  let clientId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Connected to relay server',
    clientId: clientId
  }));

  ws.on('message', (data) => {
    try {
      // Check if this is a text message (control message)
      if (data.length < 1000) {
        try {
          const message = JSON.parse(data.toString());
          
          // Client identification
          if (message.type === 'identify') {
            clientType = message.role; // 'sender' or 'receiver'
            
            if (clientType === 'sender') {
              const deviceName = message.deviceName || `Tablet-${clientId.substr(0, 6)}`;
              
              // Remove any existing sender with the same device name (prevents duplicates)
              let removedOldConnection = false;
              senders.forEach((senderInfo, oldWs) => {
                if (senderInfo.name === deviceName && oldWs !== ws) {
                  console.log(`[${new Date().toISOString()}] Removing old connection for ${deviceName}`);
                  senders.delete(oldWs);
                  try {
                    oldWs.close();
                  } catch (e) {
                    // Connection already closed
                  }
                  removedOldConnection = true;
                }
              });
              
              const sampleRate = message.sampleRate || 48000;
              const quality = message.quality || 'medium';
              
              senders.set(ws, {
                id: clientId,
                name: deviceName,
                connectedAt: Date.now(),
                lastHeartbeat: Date.now(),
                sampleRate: sampleRate,
                quality: quality
              });
              stats.activeSenders = senders.size;
              console.log(`[${new Date().toISOString()}] SENDER connected: ${deviceName} (ID: ${clientId})${removedOldConnection ? ' [replaced old connection]' : ''}`);
              
              ws.send(JSON.stringify({ 
                type: 'identified', 
                role: 'sender',
                senderId: clientId,
                deviceName: deviceName
              }));
              
              // Notify all receivers about new sender
              broadcastSenderList();
              
            } else if (clientType === 'receiver') {
              const qualityPreference = message.qualityPreference || 'medium';
              
              receivers.set(ws, {
                selectedSender: null, // null = listen to all (first sender by default)
                connectedAt: Date.now(),
                lastHeartbeat: Date.now(),
                qualityPreference: qualityPreference
              });
              stats.activeReceivers = receivers.size;
              console.log(`[${new Date().toISOString()}] RECEIVER connected (ID: ${clientId})`);
              
              ws.send(JSON.stringify({ 
                type: 'identified', 
                role: 'receiver'
              }));
              
              // Send current sender list to this receiver
              sendSenderList(ws);
            }
            
            return;
          }
          
          // Receiver selects which sender to listen to
          if (message.type === 'selectSender' && clientType === 'receiver') {
            const receiverInfo = receivers.get(ws);
            if (receiverInfo) {
              receiverInfo.selectedSender = message.senderId; // null means "listen to all"
              console.log(`[${new Date().toISOString()}] RECEIVER switched to sender: ${message.senderId || 'ALL'}`);
              ws.send(JSON.stringify({ 
                type: 'senderSelected', 
                senderId: message.senderId 
              }));
            }
            return;
          }
          
          // Receiver changes quality preference
          if (message.type === 'changeQuality' && clientType === 'receiver') {
            const receiverInfo = receivers.get(ws);
            if (receiverInfo) {
              const quality = message.quality || 'medium';
              receiverInfo.qualityPreference = quality;
              console.log(`[${new Date().toISOString()}] RECEIVER changed quality preference to: ${quality}`);
              
              // Tell all senders to switch quality
              senders.forEach((senderInfo, senderWs) => {
                if (senderWs.readyState === 1) {
                  try {
                    senderWs.send(JSON.stringify({
                      type: 'changeQuality',
                      quality: quality
                    }));
                  } catch (err) {
                    console.error(`Error sending quality change to sender: ${err.message}`);
                  }
                }
              });
              
              // Acknowledge
              ws.send(JSON.stringify({
                type: 'qualityChanged',
                quality: quality
              }));
            }
            return;
          }
          
          // Keep-alive ping/heartbeat
          if (message.type === 'ping') {
            // Update heartbeat timestamp
            if (clientType === 'sender') {
              const senderInfo = senders.get(ws);
              if (senderInfo) senderInfo.lastHeartbeat = Date.now();
            } else if (clientType === 'receiver') {
              const receiverInfo = receivers.get(ws);
              if (receiverInfo) receiverInfo.lastHeartbeat = Date.now();
            }
            ws.send(JSON.stringify({ type: 'pong' }));
            return;
          }
          
          // Handle log messages from senders
          if (message.type === 'log' && clientType === 'sender') {
            const deviceName = message.deviceName || 'Unknown';
            const logEntry = {
              timestamp: message.timestamp || Date.now(),
              level: message.level || 'info',
              message: message.message || ''
            };
            
            // Get or create log array for this device
            if (!deviceLogs.has(deviceName)) {
              deviceLogs.set(deviceName, []);
            }
            
            const logs = deviceLogs.get(deviceName);
            logs.push(logEntry);
            
            // Keep only last 200 entries
            if (logs.length > MAX_LOGS_PER_DEVICE) {
              logs.shift(); // Remove oldest
            }
            
            console.log(`[${new Date().toISOString()}] LOG from ${deviceName} [${logEntry.level}]: ${logEntry.message}`);
            return;
          }
          
          // Receiver requests logs
          if (message.type === 'getLogs' && clientType === 'receiver') {
            const deviceName = message.deviceName || null;
            
            if (deviceName && deviceLogs.has(deviceName)) {
              // Send logs for specific device
              ws.send(JSON.stringify({
                type: 'logs',
                deviceName: deviceName,
                logs: deviceLogs.get(deviceName)
              }));
            } else if (!deviceName) {
              // Send all logs
              const allLogs = {};
              deviceLogs.forEach((logs, device) => {
                allLogs[device] = logs;
              });
              ws.send(JSON.stringify({
                type: 'logs',
                allLogs: allLogs
              }));
            } else {
              // No logs for this device
              ws.send(JSON.stringify({
                type: 'logs',
                deviceName: deviceName,
                logs: []
              }));
            }
            return;
          }
          
        } catch (e) {
          // Not JSON, treat as audio data
        }
      }

      // If this is a sender, relay audio to receivers listening to this sender
      if (clientType === 'sender') {
        stats.bytesRelayed += data.length;
        const senderInfo = senders.get(ws);
        
        // Update heartbeat when audio data is received
        if (senderInfo) senderInfo.lastHeartbeat = Date.now();
        
        receivers.forEach((receiverInfo, receiverWs) => {
          if (receiverWs.readyState === 1) { // WebSocket.OPEN
            // Check if receiver wants this sender's audio
            const shouldRelay = receiverInfo.selectedSender === null || 
                               receiverInfo.selectedSender === senderInfo.id;
            
            if (shouldRelay) {
              try {
                // Prepend sender ID to audio data so receiver knows which tablet it's from
                const header = Buffer.from(JSON.stringify({ 
                  senderId: senderInfo.id,
                  senderName: senderInfo.name 
                }) + '\n');
                receiverWs.send(Buffer.concat([header, data]));
              } catch (err) {
                console.error(`Error sending to receiver: ${err.message}`);
              }
            }
          }
        });
      }
    } catch (error) {
      console.error(`Error processing message: ${error.message}`);
    }
  });

  ws.on('close', () => {
    if (clientType === 'sender') {
      const senderInfo = senders.get(ws);
      senders.delete(ws);
      stats.activeSenders = senders.size;
      console.log(`[${new Date().toISOString()}] SENDER disconnected: ${senderInfo?.name || clientId}`);
      
      // Notify receivers that a sender disconnected
      broadcastSenderList();
      
    } else if (clientType === 'receiver') {
      receivers.delete(ws);
      stats.activeReceivers = receivers.size;
      console.log(`[${new Date().toISOString()}] RECEIVER ${clientId} disconnected`);
    }
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error for ${clientId}: ${error.message}`);
  });
});

// Helper function to send sender list to a specific receiver
function sendSenderList(receiverWs) {
  const senderList = Array.from(senders.values()).map(s => ({
    id: s.id,
    name: s.name,
    connectedAt: s.connectedAt,
    quality: s.quality || 'medium',
    sampleRate: s.sampleRate || 48000
  }));
  
  try {
    receiverWs.send(JSON.stringify({
      type: 'senderList',
      senders: senderList
    }));
  } catch (err) {
    console.error('Error sending sender list:', err.message);
  }
}

// Helper function to broadcast sender list to all receivers
function broadcastSenderList() {
  const senderList = Array.from(senders.values()).map(s => ({
    id: s.id,
    name: s.name,
    connectedAt: s.connectedAt,
    quality: s.quality || 'medium',
    sampleRate: s.sampleRate || 48000
  }));
  
  receivers.forEach((receiverInfo, receiverWs) => {
    if (receiverWs.readyState === 1) {
      try {
        receiverWs.send(JSON.stringify({
          type: 'senderList',
          senders: senderList
        }));
      } catch (err) {
        console.error('Error broadcasting sender list:', err.message);
      }
    }
  });
}

// Start server
server.listen(PORT, () => {
  console.log('========================================');
  console.log('🎙️  Audio Relay Server Started');
  console.log('========================================');
  console.log(`Port: ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}`);
  console.log('========================================');
});

// Heartbeat checker - remove stale connections every 30 seconds
setInterval(() => {
  const now = Date.now();
  const timeout = 60000; // 60 seconds timeout
  
  // Check senders
  let staleCount = 0;
  senders.forEach((senderInfo, ws) => {
    if (now - senderInfo.lastHeartbeat > timeout) {
      console.log(`[${new Date().toISOString()}] Removing stale sender: ${senderInfo.name} (no activity for 60s)`);
      senders.delete(ws);
      try {
        ws.close();
      } catch (e) {
        // Already closed
      }
      staleCount++;
    }
  });
  
  if (staleCount > 0) {
    stats.activeSenders = senders.size;
    broadcastSenderList();
  }
  
  // Check receivers
  receivers.forEach((receiverInfo, ws) => {
    if (now - receiverInfo.lastHeartbeat > timeout) {
      console.log(`[${new Date().toISOString()}] Removing stale receiver (no activity for 60s)`);
      receivers.delete(ws);
      try {
        ws.close();
      } catch (e) {
        // Already closed
      }
    }
  });
  stats.activeReceivers = receivers.size;
  
}, 30000); // Check every 30 seconds

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
