// One live stream from the host to the page (Server-Sent Events): jobs, plugin state, reviews. No dependencies.
// A page that reconnects sends Last-Event-ID and gets the events it missed (the last `keep`). A new connection gets
// only what happens from now on: replaying the past to it re-ran old events (a project/changed reloaded pages forever).
export function createEvents({ keep = 200 } = {}) {
  const clients = new Map(), recent = [];
  let id = 0;
  const frame = (ev) => `id: ${ev.id}\nevent: ${ev.name}\ndata: ${JSON.stringify(ev.data)}\n\n`;
  const drop = (res) => { const ping = clients.get(res); if (ping) clearInterval(ping); clients.delete(res); };
  const write = (res, text) => { try { if (!res.writableEnded && !res.destroyed) res.write(text); else drop(res); } catch { drop(res); } };
  function emit(name, data = {}) {
    const ev = { id: ++id, name, data };
    recent.push(ev); if (recent.length > keep) recent.shift();
    const text = frame(ev);
    for (const res of [...clients.keys()]) write(res, text);
    return ev;
  }
  function handle(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'no-referrer' });
    const header = req.headers['last-event-id'];
    if (header !== undefined) { const last = Number(header) || 0; for (const ev of recent) if (ev.id > last) write(res, frame(ev)); }
    write(res, ': connected\n\n');
    const ping = setInterval(() => write(res, ': ping\n\n'), 25000);
    clients.set(res, ping);
    req.on('close', () => drop(res));
    res.on('error', () => drop(res));
  }
  function close() { for (const res of [...clients.keys()]) { drop(res); try { res.end(); } catch { /* gone */ } } }
  return { emit, handle, close, get clients() { return clients.size; } };
}
