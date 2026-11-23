// Notes on an image: numbered pins dropped on it with a note each, one overall note, and "Regenerate from this".
// The pins are drawn over the image in the large view; what is sent also carries a copy of the image with them on it.
import { h } from '/shell/ui.js';

const MAX_PINS = 12, MARK = '#ff2d55', MAX_CHARS = 1.8 * 1024 * 1024;

/** The image with its numbered pins drawn on it, as a JPEG data URL small enough for a request (a plugin route takes
 *  2 MB): at most 1536 px on its longer side, the quality stepped down until it fits. */
export async function markedCopy(img, pins) {
  if (!img.complete || !img.naturalWidth) await img.decode();
  const scale = Math.min(1, 1536 / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(img.naturalWidth * scale), height: Math.round(img.naturalHeight * scale) });
  const c = canvas.getContext('2d'), r = Math.max(canvas.width, canvas.height) * 0.022;
  c.fillStyle = '#fff'; c.fillRect(0, 0, canvas.width, canvas.height);   // JPEG has no see-through: white behind
  c.drawImage(img, 0, 0, canvas.width, canvas.height);
  pins.forEach((p, i) => {
    const x = p.x * canvas.width, y = p.y * canvas.height;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = MARK; c.fill(); c.lineWidth = 3; c.strokeStyle = '#fff'; c.stroke();
    c.fillStyle = '#fff'; c.font = `bold ${Math.round(r * 1.2)}px sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(String(i + 1), x, y + r * 0.06);
  });
  for (const quality of [0.9, 0.8, 0.7, 0.55, 0.4]) { const url = canvas.toDataURL('image/jpeg', quality); if (url.length <= MAX_CHARS) return url; }
  throw new Error('This picture is too large to send back with pins: use the overall note alone.');
}

/**
 * The side panel of the large view for one image. stage holds the image (pins are placed in it, by percentage);
 * onSend({ pins, note, count, marked }) starts the new round.
 */
export function notesPanel({ stage, img, onSend, disabled = '' }) {
  const pins = []; let marking = false, sending = false, count = 2;
  const list = h('div', { className: 'mm-notes-list' }), say = h('p', { className: 'mm-note' });
  const all = h('textarea', { className: 'mm-notes-all', maxLength: 1000, placeholder: 'Anything about the whole picture (optional)', oninput: () => ready() });
  const add = h('button', { className: 'mm-btn mm-notes-add', type: 'button', onclick: () => mark(!marking) });
  const send = h('button', { className: 'mm-btn primary mm-notes-send', type: 'button', textContent: 'Regenerate from this', title: disabled, onclick: go });
  const many = h('input', { type: 'number', min: 1, max: 8, value: count, oninput: (e) => { count = Math.max(1, Math.min(8, Math.round(Number(e.target.value)) || 1)); } });

  const filled = () => pins.filter((p) => p.note.trim());
  function ready() { send.disabled = sending || !!disabled || !(filled().length || all.value.trim()); }
  function mark(on) {
    marking = on; stage.classList.toggle('marking', on);
    add.textContent = on ? 'Done placing pins' : pins.length ? 'Add more pins' : 'Add notes';
    say.textContent = on ? 'Click on the picture where something should change.' : '';
  }
  function draw() {
    for (const old of stage.querySelectorAll('.mm-pin')) old.remove();
    pins.forEach((p, i) => stage.append(h('span', { className: 'mm-pin', textContent: String(i + 1), style: `left:${p.x * 100}%;top:${p.y * 100}%` })));
    list.replaceChildren(...pins.map((p, i) => h('div', { className: 'mm-notes-pin' }, h('span', { className: 'mm-pin still', textContent: String(i + 1) }),
      h('textarea', { maxLength: 300, placeholder: 'What should change here?', value: p.note, oninput: (e) => { p.note = e.target.value; ready(); } }),
      h('button', { className: 'mm-btn', type: 'button', textContent: '✕', title: 'Remove this pin', onclick: () => { pins.splice(i, 1); draw(); } }))));
    ready();
  }
  stage.addEventListener('click', (e) => {
    if (!marking || !stage.isConnected || !list.isConnected) return;
    if (pins.length >= MAX_PINS) { say.textContent = `At most ${MAX_PINS} pins.`; return; }
    const box = img.getBoundingClientRect(); if (!box.width || !box.height) return;
    const unit = (n) => Math.max(0, Math.min(1, n));
    pins.push({ x: unit((e.clientX - box.left) / box.width), y: unit((e.clientY - box.top) / box.height), note: '' });
    draw(); list.lastElementChild?.querySelector('textarea')?.focus();
  });
  async function go() {
    sending = true; ready(); say.textContent = 'Sending…';
    try {
      const kept = filled().map((p) => ({ x: p.x, y: p.y, note: p.note.trim() }));
      await onSend({ pins: kept, note: all.value.trim(), count, marked: kept.length ? await markedCopy(img, kept) : null });
    } catch (e) { say.textContent = e.message; say.className = 'mm-bad'; sending = false; ready(); }
  }
  mark(false); draw();
  return h('div', { className: 'mm-notes' }, h('h3', { textContent: 'Not quite right?' }),
    h('p', { className: 'mm-note', textContent: 'Pin what should change, say how, and a new round is made from this picture.' }),
    add, say, list, h('label', { textContent: 'Overall' }), all,
    h('div', { className: 'mm-row' }, h('span', { className: 'mm-note', textContent: 'How many' }), many, h('span', { className: 'grow' }), send),
    disabled ? h('p', { className: 'mm-bad', textContent: disabled }) : null);
}
