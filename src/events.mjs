// One live stream from the host to the page (Server-Sent Events): jobs, plugin state, reviews. No dependencies.
// A page that reconnects sends Last-Event-ID and gets the events it missed (the last `keep`). A new connection gets
// only what happens from now on: replaying the past to it re-ran old events (a project/changed reloaded pages forever).
export function createEvents({ keep = 200 } = {}) {
  const clients = new Set(), recent = [];
  let id = 0;
  const frame = (ev) => `id: ${ev.id}\nevent: ${ev.name}\ndata: ${JSON.stringify(ev.data)}\n\n`;
  function emit(name, data = {}) {
    const ev = { id: ++id, name, data };
    recent.push(ev); if (recent.length > keep) recent.shift();
    const text = frame(ev);
    for (const res of clients) res.write(text);
    return ev;
  }
  function handle(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
    const header = req.headers['last-event-id'];
    if (header !== undefined) { const last = Number(header) || 0; for (const ev of recent) if (ev.id > last) res.write(frame(ev)); }
    res.write(': connected\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
  }
  function close() { for (const res of clients) res.end(); clients.clear(); }
  return { emit, handle, close, get clients() { return clients.size; } };
}
