// The NFGames UI kit: small custom elements (light DOM, styled by theme.css) and a few functions every tool and plugin
// uses, so everything looks and behaves alike. Import from "/shell/ui.js".
export const h = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k); return e; };
const label = (el) => h('span', { className: 'nf-label', textContent: el.getAttribute('label') || '' });

class NfButton extends HTMLElement {
  connectedCallback() {
    if (this.btn) return;
    this.btn = h('button', { type: 'button', className: `nf-btn ${this.getAttribute('variant') || ''}`, disabled: this.hasAttribute('disabled') }, ...this.childNodes);
    this.append(this.btn);
  }
  static get observedAttributes() { return ['disabled']; }
  attributeChangedCallback() { if (this.btn) this.btn.disabled = this.hasAttribute('disabled'); }
}
class NfField extends HTMLElement { connectedCallback() { if (this.done) return; this.done = true; const kids = [...this.childNodes]; this.append(label(this), h('span', {}, ...kids)); } }
class NfNumber extends HTMLElement {
  connectedCallback() {
    if (this.input) return;
    this.input = h('input', { type: 'number', step: this.getAttribute('step') || 'any', value: this.getAttribute('value') ?? '' });
    for (const a of ['min', 'max']) if (this.hasAttribute(a)) this.input[a] = this.getAttribute(a);
    this.input.addEventListener('change', () => this.dispatchEvent(new CustomEvent('change', { detail: { value: this.value } })));
    this.append(label(this), this.input);
  }
  get value() { return this.input ? Number(this.input.value) : Number(this.getAttribute('value')); }
  set value(v) { if (this.input) this.input.value = v; else this.setAttribute('value', v); }
}
class NfSelect extends HTMLElement {
  connectedCallback() {
    if (this.sel) return;
    this.sel = h('select'); this.sel.addEventListener('change', () => this.dispatchEvent(new CustomEvent('change', { detail: { value: this.value } })));
    this.append(label(this), this.sel); this.#fill();
  }
  set options(list) { this._options = list; this.#fill(); } get options() { return this._options || []; }
  get value() { return this.sel ? this.sel.value : this._value; } set value(v) { this._value = v; if (this.sel) this.sel.value = v; }
  #fill() { if (!this.sel) return; this.sel.replaceChildren(...this.options.map((o) => h('option', { value: o.value, textContent: o.label ?? o.value }))); if (this._value !== undefined) this.sel.value = this._value; }
}
class NfTag extends HTMLElement {}
class NfProgress extends HTMLElement {
  connectedCallback() { if (!this.bar) { this.bar = h('i'); this.append(this.bar); } this.#show(); }
  static get observedAttributes() { return ['value']; }
  attributeChangedCallback() { this.#show(); }
  #show() { if (this.bar) this.bar.style.width = this.hasAttribute('value') ? `${Math.max(0, Math.min(1, Number(this.getAttribute('value')))) * 100}%` : ''; }
}
class NfPanel extends HTMLElement {
  connectedCallback() { if (this.body) return; const kids = [...this.childNodes]; this.body = h('div', { className: 'nf-panel-body' }, ...kids); this.append(h('div', { className: 'nf-panel-title', textContent: this.getAttribute('title') || '' }), this.body); }
}
class NfList extends HTMLElement {
  set items(list) { this._items = list; this.#draw(); } get items() { return this._items || []; }
  set render(fn) { this._render = fn; this.#draw(); }
  connectedCallback() { this.#draw(); }
  #draw() {
    const render = this._render || ((i) => String(i.label ?? i));
    this.replaceChildren(...this.items.map((item) => { const row = h('div', { className: 'nf-row' }, render(item)); row.onclick = () => { for (const r of this.children) r.classList.toggle('on', r === row); this.dispatchEvent(new CustomEvent('select', { detail: { item } })); }; return row; }));
  }
}
class NfTree extends HTMLElement {
  set items(list) { this._items = list; this.#draw(); } get items() { return this._items || []; }
  connectedCallback() { this.#draw(); }
  #draw() {
    const node = (item) => {
      const kids = item.children && item.children.length ? h('div', { className: 'nf-tree-kids' }, ...item.children.map(node)) : null;
      const row = h('div', { className: 'nf-row', textContent: `${kids ? '▾ ' : ''}${item.label}` });
      row.onclick = () => { if (kids) { kids.hidden = !kids.hidden; row.textContent = `${kids.hidden ? '▸' : '▾'} ${item.label}`; } this.dispatchEvent(new CustomEvent('select', { detail: { item } })); };
      return h('div', {}, row, kids);
    };
    this.replaceChildren(...this.items.map(node));
  }
}
class NfTabs extends HTMLElement {
  connectedCallback() {
    if (this.bar) return;
    const panes = [...this.children]; this.bar = h('div', { className: 'nf-tabbar' }); this.prepend(this.bar);
    const show = (i) => { panes.forEach((p, j) => { p.hidden = i !== j; }); [...this.bar.children].forEach((t, j) => t.classList.toggle('on', i === j)); };
    panes.forEach((p, i) => this.bar.append(h('span', { className: 'nf-tab', textContent: p.getAttribute('title') || `Tab ${i + 1}`, onclick: () => show(i) })));
    show(0);
  }
}

/** A three.js view: orbit, grid, framing and picking, on the editor's one pinned three.js (installed on demand). */
class NfViewport extends HTMLElement {
  connectedCallback() { if (!this.ready) this.ready = this.#start(); else this.three?.renderer.setAnimationLoop(this.loop); }
  disconnectedCallback() { this.three?.renderer.setAnimationLoop(null); }
  async #start() {
    const info = await fetch('/api/viewer').then((r) => r.json());
    if (!info.three.installed) {
      const btn = h('button', { className: 'nf-btn primary', textContent: `Install three.js ${info.three.version}` });
      btn.onclick = async () => { btn.disabled = true; btn.textContent = 'Installing…'; const r = await fetch('/api/vendor/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); if (r.ok) location.reload(); else { btn.disabled = false; btn.textContent = `Not installed: ${(await r.json()).error}`; } };
      this.replaceChildren(h('div', { className: 'nf-empty' }, h('p', { textContent: '3D views need three.js, which is installed on demand.' }), btn));
      return null;
    }
    const T = await import('three');
    const [{ OrbitControls }, { RoomEnvironment }] = await Promise.all([import('three/addons/controls/OrbitControls.js'), import('three/addons/environments/RoomEnvironment.js')]);
    const canvas = h('canvas'); this.replaceChildren(canvas);
    const renderer = new T.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.toneMapping = T.ACESFilmicToneMapping;
    const scene = new T.Scene(); scene.background = new T.Color(getComputedStyle(this).getPropertyValue('--nf-raised').trim() || '#252a35');
    scene.environment = new T.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
    const camera = new T.PerspectiveCamera(45, 1, 0.01, 1e5); camera.position.set(4, 3, 6);
    const controls = new OrbitControls(camera, canvas); controls.enableDamping = true;
    const grid = new T.GridHelper(20, 20, 0x3a4252, 0x2c3240); scene.add(grid);
    const resize = () => { const w = this.clientWidth || 300, ht = this.clientHeight || 240; renderer.setSize(w, ht, false); camera.aspect = w / ht; camera.updateProjectionMatrix(); };
    new ResizeObserver(resize).observe(this); resize();
    this.loop = () => { controls.update(); renderer.render(scene, camera); }; renderer.setAnimationLoop(this.loop);
    const ray = new T.Raycaster(), ndc = new T.Vector2(); let down = null;
    canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || !this.object) return;
      const r = canvas.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, camera);
      this.dispatchEvent(new CustomEvent('pick', { detail: ray.intersectObject(this.object, true)[0] || null }));
    });
    this.three = { T, renderer, scene, camera, controls, grid };
    return this.three;
  }
  async setObject(obj) { const t = await this.ready; if (!t) return; if (this.object) t.scene.remove(this.object); this.object = obj; if (obj) { t.scene.add(obj); this.frame(); } }
  frame() {
    const t = this.three; if (!t || !this.object) return;
    const box = new t.T.Box3().setFromObject(this.object), size = box.getSize(new t.T.Vector3()), c = box.getCenter(new t.T.Vector3()), r = Math.max(size.x, size.y, size.z) || 1;
    t.controls.target.copy(c); t.camera.position.copy(c).add(new t.T.Vector3(1, 0.6, 1).normalize().multiplyScalar(r * 1.6));
    t.camera.near = r / 1000; t.camera.far = r * 1000; t.camera.updateProjectionMatrix(); t.grid.scale.setScalar(Math.max(1, r / 10)); t.grid.position.y = box.min.y;
  }
}

for (const [name, cls] of Object.entries({ 'nf-button': NfButton, 'nf-field': NfField, 'nf-number': NfNumber, 'nf-select': NfSelect, 'nf-tag': NfTag, 'nf-progress': NfProgress, 'nf-panel': NfPanel, 'nf-list': NfList, 'nf-tree': NfTree, 'nf-tabs': NfTabs, 'nf-viewport': NfViewport }))
  if (!customElements.get(name)) customElements.define(name, cls);

let toasts = null;
/** A short message in the corner: tone '' (done), 'warn' or 'error'. */
export function toast(text, tone = '') {
  if (!toasts) { toasts = h('div', { className: 'nf-toasts' }); document.body.append(toasts); }
  const t = h('div', { className: `nf-toast ${tone}`, textContent: text }); toasts.append(t);
  setTimeout(() => t.remove(), tone === 'error' ? 9000 : 4000);
}
/** A modal dialog: resolves with the clicked action's value (or null when closed). */
export function dialog({ title, body, actions = [{ label: 'Close', value: null }] }) {
  return new Promise((done) => {
    const d = h('dialog', { className: 'nf-dialog' }, h('header', { textContent: title }), h('div', { className: 'nf-dialog-body' }, body),
      h('footer', {}, ...actions.map((a) => h('button', { className: `nf-btn ${a.variant || ''}`, textContent: a.label, onclick: () => { d.close(); done(a.value); } }))));
    d.addEventListener('close', () => { d.remove(); done(null); });
    document.body.append(d); d.showModal();
  });
}
export const confirmDialog = (title, text, ok = 'OK') => dialog({ title, body: typeof text === 'string' ? h('p', { textContent: text }) : text, actions: [{ label: 'Cancel', value: false }, { label: ok, value: true, variant: 'primary' }] }).then((v) => v === true);
