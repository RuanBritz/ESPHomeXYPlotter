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
let awaitingResponse = false;
let commandResponse = null;

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
    console.log('<<:', msg);
    broadcast(msg);
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

app.post('/send-line', (req, res) => {
  const { line } = req.body;

  if (!tcpClient || !isConnected) {
    return res.status(400).send('Not connected');
  }

  awaitingResponse = true;
  commandResponse = null;

  // Send the line
  tcpClient.write(line + '\n');

  console.log(`>>: ${line}`);
  broadcast(`>> ${line}`);
  res.send('ok');
});

app.listen(PORT, () => {
  console.log(`🌐 Server running at http://localhost:${PORT}`);
});
