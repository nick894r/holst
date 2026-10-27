// Маленький сервер-ретранслятор для «Холст P2P». Без зависимостей: нужен только Node.js.
// Запуск: node server.js   (или двойной клик по start-server.bat)
// Отдаёт index.html и пересылает сообщения между всеми подключёнными браузерами.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const PORT = +process.env.PORT || 8080;
const clients = new Set();

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/relay-ping') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('p2p-canvas-relay'); }
  if (u === '/' || u === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
      if (e) { res.writeHead(500); return res.end('index.html не найден рядом с server.js'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(d);
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

function frame(op, payload) {
  const len = payload.length; let h;
  if (len < 126) h = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(len, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([h, payload]);
}
const send = (c, text) => { try { c.socket.write(frame(1, Buffer.from(text))); } catch (e) {} };
function relay(from, text) {
  const f = frame(1, Buffer.from(text));
  for (const o of clients) if (o !== from) try { o.socket.write(f); } catch (e) {}
}

function parse(c) {
  for (;;) {
    const b = c.buf; if (b.length < 2) return;
    const fin = !!(b[0] & 0x80), op = b[0] & 15, masked = !!(b[1] & 0x80);
    let len = b[1] & 127, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (len > 64 * 1024 * 1024) { c.socket.destroy(); return; }
    const hdr = off + (masked ? 4 : 0), need = hdr + len;
    if (b.length < need) return;
    let payload = b.subarray(hdr, need);
    if (masked) { const m = b.subarray(off, off + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
    c.buf = b.subarray(need);
    if (op === 8) { try { c.socket.end(frame(8, Buffer.alloc(0))); } catch (e) {} return; }
    if (op === 9) { c.socket.write(frame(10, payload)); continue; }
    if (op === 10) continue;
    if (op === 1 || op === 2) { c.frag = [payload]; c.fragOp = op; } else if (op === 0) c.frag.push(payload);
    if (fin) { const msg = Buffer.concat(c.frag).toString('utf8'); const o = c.fragOp; c.frag = []; if (o === 1) relay(c, msg); }
  }
}

server.on('upgrade', (req, socket) => {
  if (req.url.split('?')[0] !== '/ws' || !req.headers['sec-websocket-key']) { socket.destroy(); return; }
  const key = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + key + '\r\n\r\n');
  socket.setNoDelay(true);
  const c = { socket, buf: Buffer.alloc(0), frag: [], fragOp: 0 };
  for (const o of clients) send(o, JSON.stringify({ t: 'need' })); // новичку остальные пришлют состояние поля
  clients.add(c);
  console.log('[+] подключился участник, всего:', clients.size);
  socket.on('data', d => { c.buf = Buffer.concat([c.buf, d]); parse(c); });
  const drop = () => { if (clients.delete(c)) console.log('[-] отключился участник, всего:', clients.size); socket.destroy(); };
  socket.on('close', drop); socket.on('error', drop);
});

setInterval(() => { for (const c of clients) try { c.socket.write(frame(9, Buffer.alloc(0))); } catch (e) {} }, 25000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n=== Холст P2P: сервер запущен ===');
  console.log('У вас:            http://localhost:' + PORT);
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log('Для друзей (' + name + '): http://' + i.address + ':' + PORT);
  console.log('\nДрузья открывают адрес в браузере — подключение произойдёт само.');
  console.log('Не закрывайте это окно, пока рисуете. Остановка: Ctrl+C.\n');
});
