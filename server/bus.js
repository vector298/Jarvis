import { EventEmitter } from 'node:events';

// Server-sent events hub. One browser is the normal case, but nothing here
// assumes it.
class Bus extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set();
    this.seq = 0;
  }

  attach(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    this.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }

  publish(type, payload = {}) {
    const frame = `id: ${++this.seq}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.clients) res.write(frame);
    this.emit(type, payload);
  }
}

export const bus = new Bus();
