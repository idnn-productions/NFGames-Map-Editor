// An image, large, over the tab: stepped through with its neighbours (← → and the buttons), closed with Esc, the ✕
// or a click beside it. A caller's own controls for the image shown (the notes panel) go beside it, from `extra`.
import { h } from '/shell/ui.js';

/**
 * images: [{ path, src, caption, pickable, picked }]. onPick(path) is asked for a pickable image; the view closes
 * when it is done. extra(image, { close, stage, img }) returns a node for the side of that image, or null.
 * Returns the function that closes it.
 */
export function openLarge({ host, images, index = 0, onPick = null, extra = null }) {
  let at = Math.max(0, Math.min(images.length - 1, index)), open = true;
  const img = h('img', { className: 'mm-large-img', alt: '' });
  const stage = h('div', { className: 'mm-large-stage' }, img);
  const caption = h('span', { className: 'mm-large-caption' });
  const pick = h('button', { className: 'mm-btn primary mm-large-pick', type: 'button' });
  const prev = h('button', { className: 'mm-btn mm-large-prev', type: 'button', textContent: '←', title: 'The one before (←)', onclick: () => step(-1) });
  const next = h('button', { className: 'mm-btn mm-large-next', type: 'button', textContent: '→', title: 'The next one (→)', onclick: () => step(1) });
  const side = h('div', { className: 'mm-large-side' });
  const box = h('div', { className: 'mm-large' },
    h('div', { className: 'mm-large-bar' }, prev, next, caption, h('span', { className: 'grow' }), pick,
      h('button', { className: 'mm-btn mm-large-close', type: 'button', textContent: '✕', title: 'Close (Esc)', onclick: () => close() })),
    h('div', { className: 'mm-large-body' }, h('div', { className: 'mm-large-pane' }, stage), side));
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Image, large');

  function show() {
    const image = images[at];
    for (const pin of stage.querySelectorAll('.mm-pin')) pin.remove();
    stage.classList.remove('marking');
    img.src = image.src; img.alt = image.caption || 'image';
    caption.textContent = `${image.caption || ''}${images.length > 1 ? `   ${at + 1} of ${images.length}` : ''}`;
    prev.hidden = next.hidden = images.length < 2;
    pick.hidden = !(onPick && image.pickable); pick.disabled = !!image.picked; pick.textContent = image.picked ? 'Picked' : 'Pick this one';
    const more = extra ? extra(image, { close, stage, img }) : null;
    side.replaceChildren(...(more ? [more] : [])); side.hidden = !more;
  }
  function step(by) { at = (at + by + images.length) % images.length; show(); }
  function close() { if (!open) return; open = false; document.removeEventListener('keydown', keys, true); box.remove(); }
  function keys(e) {
    if (!box.isConnected) return close();
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '');
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (!typing && images.length > 1 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); step(e.key === 'ArrowLeft' ? -1 : 1); }
  }
  pick.onclick = async () => { pick.disabled = true; try { await onPick(images[at].path); } finally { close(); } };
  // a click beside the image closes; one on the image, the bar or the side does not
  box.addEventListener('click', (e) => { if (e.target === box || e.target.classList.contains('mm-large-body') || e.target.classList.contains('mm-large-pane')) close(); });
  document.addEventListener('keydown', keys, true);
  host.append(box); show(); (pick.hidden ? box.querySelector('.mm-large-close') : pick).focus();
  return close;
}
