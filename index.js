const express = require('express');
const net = require('net');
const bodyParser = require('body-parser');

const app = express();
const PORT = 3000;

app.use(express.static('public'));
app.use(bodyParser.json());

let tcpClient = null;
let isConnected = false;
let clients = [];

let sending = false;
const pendingRequests = [];

// SSE for terminal output
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  clients.push(res);
  req.on('close', () => {
    clients = clients.filter(client => client !== res);
  });
});

function broadcast(data) {
  clients.forEach(client => client.write(`data: ${data}\n\n`));
}

app.post('/connect', (req, res) => {
  const { ip, port } = req.body;

  if (isConnected && tcpClient) {
    return res.status(400).send('Already connected');
  }

  tcpClient = new net.Socket();

  tcpClient.connect(port, ip, () => {
    isConnected = true;
    console.log(`Connected to ${ip}:${port}`);
    broadcast(`✅ Connected to ${ip}:${port}`);
    res.send('Connected');
  });

  tcpClient.on('data', (data) => {
    const msg = data.toString().trim();

    // Check if there's a pending request
    const currentRequest = pendingRequests.shift();
    if (currentRequest) {
      currentRequest.resolve(msg);
    }

    console.log('<<:', msg);
    broadcast('<< ' + msg);
  });

  tcpClient.on('close', () => {
    console.log('TCP connection closed');
    broadcast('❌ Connection closed');
    isConnected = false;
    tcpClient = null;
  });

  tcpClient.on('error', (err) => {
    console.error('TCP error:', err.message);
    broadcast(`⚠️ TCP Error: ${err.message}`);
    isConnected = false;
    tcpClient = null;
    res.status(500).send('TCP error');
  });
});

app.post('/disconnect', (req, res) => {
  if (tcpClient && isConnected) {
    tcpClient.destroy();
    isConnected = false;
    tcpClient = null;
    sending = false;
    broadcast('🔌 Disconnected from ESP32');
    res.send('Disconnected');
  } else {
    res.status(400).send('Not connected');
  }
});

app.post('/send-line', async (req, res) => {
  const { line } = req.body;

  if (!tcpClient || !isConnected) {
    return res.status(400).send('Not connected');
  }

  try {
    const response = await sendCommand(line);
    res.send(response);
  } catch (err) {
    res.status(504).send('TCP response timed out');
  }
});

// Helper to send a command and wait for a response
function sendCommand(line) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout waiting for response'));
      // Remove this request from the queue if it’s still there
      const idx = pendingRequests.findIndex(r => r.resolve === resolve);
      if (idx !== -1) pendingRequests.splice(idx, 1);
    }, 5000);

    pendingRequests.push({
      resolve: (msg) => {
        clearTimeout(timeout);
        resolve(msg);
      },
      reject
    });

    // Write to TCP
    tcpClient.write(line + '\n');
    console.log(`>>: ${line}`);
    broadcast(`>> ${line}`);
  });
}

app.listen(PORT, () => {
  console.log(`🌐 Server running at http://localhost:${PORT}`);
});
