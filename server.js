// server.js – HTTP(S) прокси через WebSocket для Render
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const url = require('url');

const PORT = process.env.PORT || 10000;

// Простой HTTP-сервер для ответов на проверки Render
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('HTTPS Tunnel Server OK');
});

// WebSocket на том же сервере
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      console.error('Invalid JSON');
      return;
    }

    const { requestId, method, url: targetUrl, headers, body } = data;
    const parsed = url.parse(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.path,
      method: method,
      headers: headers || {},
    };

    delete options.headers['connection'];
    delete options.headers['keep-alive'];
    delete options.headers['proxy-connection'];

    const proxyReq = httpModule.request(options, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        ws.send(JSON.stringify({
          requestId,
          statusCode: proxyRes.statusCode,
          headers: proxyRes.headers,
          body: Buffer.concat(chunks).toString('base64'),
        }));
      });
    });

    proxyReq.on('error', (err) => {
      ws.send(JSON.stringify({ requestId, error: err.message }));
    });

    if (body) {
      proxyReq.write(Buffer.from(body, 'base64'));
    }
    proxyReq.end();
  });

  ws.on('close', () => console.log('Client disconnected'));
  ws.on('error', (err) => console.error('WS error:', err.message));
});

// Слушаем на всех интерфейсах
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
});