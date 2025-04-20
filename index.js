const express = require('express');
const net = require('net');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = 3000;

app.use(express.static('public'));
app.use(bodyParser.json());

let tcpClient = null;
let isPlotterConnected = false;
let wsClients = new Set();

// Handle WebSocket connections
wss.on('connection', (ws) => {
  wsClients.add(ws);
  log('🌐 WebSocket client connected');

  ws.on('message', async (message) => {
    try {
      if (!tcpClient || !isPlotterConnected) {
        return ws.send('XY Plotter not connected');
      }

      try {
        let command = message.toString();
        tcpClient.write(command + '\n');
        console.log(`>> ${command}`);
      } catch (err) {
        ws.send(err.message);
      }
    } catch (err) {
      ws.send(err.message);
    }
  });

  ws.on('close', () => {
    wsClients.delete(ws);
    log('❌ WebSocket client disconnected');
  });
});

// Connect to XY Plotter using a socket connection
app.post('/connect', (req, res) => {
  const { ip, port } = req.body;

  if (isPlotterConnected && tcpClient) {
    return res.status(200).send('Already connected');
  }

  tcpClient = new net.Socket();

  tcpClient.once('error', (err) => {
    isPlotterConnected = false;
    tcpClient = null;
    log(`⚠️ TCP Error: ${err.message}`);
  });

  tcpClient.connect(port, ip, () => {
    isPlotterConnected = true;
    log(`✅ Connected to ${ip}:${port}`);
    res.status(200).send('Connected');

    tcpClient.on('data', (data) => {
      log(`<< ${data.toString().trim()}`);
    });

    tcpClient.on('close', () => {
      isPlotterConnected = false;
      tcpClient = null;
      log('❌ Connection closed');
    });
  });
});

// Disconnect from XY Plotter
app.post('/disconnect', (req, res) => {
  if (tcpClient && isPlotterConnected) {
    tcpClient.destroy();
    isPlotterConnected = false;
    tcpClient = null;
    log('🔌 Disconnected from ESP32');
    res.send('Disconnected');
  } else {
    res.status(400).send('Not connected');
  }
});

function log(message) {
  console.log(message);
  broadcastToWebSockets(message);
}

function broadcastToWebSockets(data) {
  wsClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

server.listen(PORT, () => {
  log(`🚀 Server running at http://localhost:${PORT}`);
});