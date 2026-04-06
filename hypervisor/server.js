const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = 3333;
const dir = __dirname;

const MIME = {
  '.html': 'text/html',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// ============================================================
// HTTP Static File Server (preserved from original)
// ============================================================

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = url === '/' ? '/index.html' : url;
  const filePath = path.join(dir, file);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'text/plain',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  });
});

// ============================================================
// WebSocket Room Relay (MDV-T01)
// Endpoint: /ws/room/:roomId
// Devices join rooms via 4-digit codes. Messages from one
// client are relayed to all others in the same room.
// ============================================================

const rooms = new Map(); // roomId -> Set<ws>
const ROOM_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_DEVICES_PER_ROOM = 8;

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 }); // 64KB cap prevents memory exhaustion

server.on('upgrade', (req, socket, head) => {
  const match = req.url.match(/^\/ws\/room\/(\w+)$/);
  if (!match) {
    socket.destroy();
    return;
  }
  const roomId = match[1];

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, roomId);
  });
});

wss.on('connection', (ws, roomId) => {
  // Create room if it doesn't exist
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { clients: new Set(), lastActivity: Date.now() });
    console.log(`[Room ${roomId}] Created`);
  }

  const room = rooms.get(roomId);

  // Enforce max devices
  if (room.clients.size >= MAX_DEVICES_PER_ROOM) {
    ws.close(4001, 'Room full');
    return;
  }

  ws.isAlive = true;
  room.clients.add(ws);
  room.lastActivity = Date.now();
  console.log(`[Room ${roomId}] Device joined (${room.clients.size} connected)`);

  // Notify the new device of room state + role assignment
  ws.send(JSON.stringify({
    type: 'room-state',
    deviceCount: room.clients.size,
    roomId,
    role: room.clients.size === 1 ? 'emitter' : 'recorder',
  }));

  // Heartbeat: detect crashed devices via ping/pong
  ws.on('pong', () => { ws.isAlive = true; });

  // Broadcast join to others
  for (const client of room.clients) {
    if (client !== ws && client.readyState === 1) {
      client.send(JSON.stringify({
        type: 'device-joined',
        deviceCount: room.clients.size,
      }));
    }
  }

  // Relay messages to all other clients in the room
  ws.on('message', (data) => {
    room.lastActivity = Date.now();
    for (const client of room.clients) {
      if (client !== ws && client.readyState === 1) {
        client.send(data);
      }
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    console.log(`[Room ${roomId}] Device left (${room.clients.size} remaining)`);

    // Broadcast leave to remaining clients
    for (const client of room.clients) {
      if (client.readyState === 1) {
        client.send(JSON.stringify({
          type: 'device-left',
          deviceCount: room.clients.size,
        }));
      }
    }

    // Destroy room when empty
    if (room.clients.size === 0) {
      rooms.delete(roomId);
      console.log(`[Room ${roomId}] Destroyed (empty)`);
    }
  });

  ws.on('error', (err) => {
    console.error(`[Room ${roomId}] WebSocket error:`, err.message);
  });
});

// Heartbeat: detect crashed/disconnected devices every 10 seconds
setInterval(() => {
  for (const [roomId, room] of rooms) {
    for (const client of room.clients) {
      if (!client.isAlive) {
        console.log(`[Room ${roomId}] Heartbeat timeout — terminating dead client`);
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }
}, 10000);

// Room cleanup: expire inactive rooms every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (now - room.lastActivity > ROOM_TIMEOUT_MS) {
      for (const client of room.clients) {
        client.close(4002, 'Room expired');
      }
      rooms.delete(roomId);
      console.log(`[Room ${roomId}] Expired (inactive ${ROOM_TIMEOUT_MS / 60000} min)`);
    }
  }
}, 5 * 60 * 1000);

// ============================================================
// Start Server
// ============================================================

server.listen(PORT, () => {
  console.log(`Hypervisor running on http://localhost:${PORT}`);
  console.log(`WebSocket rooms at ws://localhost:${PORT}/ws/room/:roomId`);
});
