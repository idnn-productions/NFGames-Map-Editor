// Directed Meshes workbench tool: Browse & 1-click import curated meshes + Share local models.
import { h } from '/shell/ui.js';

const CATEGORIES = [
  ['', 'All categories'],
  ['props', 'Props'],
  ['architecture', 'Architecture'],
  ['nature', 'Nature & Foliage'],
  ['characters', 'Characters'],
  ['vehicles', 'Vehicles'],
  ['weapons', 'Weapons & Gear'],
  ['environment', 'Environment & Terrain'],
  ['misc', 'Other'],
];

export function activate(api) {
  let activeTab = 'browse';
  let panelEl = null;

  async function renderPanel() {
    if (!panelEl) return;
    const tabs = h('div', { style: 'display:flex;gap:6px;margin-bottom:10px' },
      h('button', { className: `nf-btn${activeTab === 'browse' ? ' primary' : ''}`, textContent: 'Browse & Import', onclick: () => { activeTab = 'browse'; renderPanel(); } }),
      h('button', { className: `nf-btn${activeTab === 'share' ? ' primary' : ''}`, textContent: 'Share Model', onclick: () => { activeTab = 'share'; renderPanel(); } })
    );
    const body = h('div', { style: 'display:grid;gap:10px' });
    panelEl.replaceChildren(tabs, body);
    if (activeTab === 'browse') await renderBrowse(body);
    else await renderShare(body);
  }

  async function renderBrowse(body) {
    const qInput = h('input', { className: 'nf-input', placeholder: 'Search curated meshes…', style: 'width:100%' });
    const catSelect = h('select', { className: 'nf-input', style: 'width:100%' },
      ...CATEGORIES.map(([v, label]) => h('option', { value: v, textContent: label }))
    );
    const listEl = h('div', { style: 'display:grid;gap:8px' }, h('p', { className: 'nf-muted', textContent: 'Loading curated meshes…' }));

    async function load() {
      listEl.replaceChildren(h('p', { className: 'nf-muted', textContent: 'Loading…' }));
      try {
        const qs = new URLSearchParams();
        if (qInput.value.trim()) qs.set('q', qInput.value.trim());
        if (catSelect.value) qs.set('category', catSelect.value);
        const data = await api.fetch(`/remote?${qs.toString()}`);
        const items = data.items || [];
        if (!items.length) {
          listEl.replaceChildren(h('p', { className: 'nf-muted', textContent: 'No curated meshes match yet. Switch to Share Model to submit one!' }));
          return;
        }
        listEl.replaceChildren(...items.map((m) => {
          const btn = h('button', {
            className: 'nf-btn primary',
            textContent: 'Import',
            onclick: async () => {
              btn.disabled = true;
              btn.textContent = 'Importing…';
              try {
                const res = await api.fetch('/import', { method: 'POST', body: JSON.stringify({ id: m.id, includeRefs: true }) });
                api.ui.toast(`Imported ${m.title} → ${res.path}`);
                window.nfWorkbench?.openView('viewer', { model: res.modelParam });
              } catch (e) {
                api.ui.toast(e.message, 'error');
              } finally {
                btn.disabled = false;
                btn.textContent = 'Import';
              }
            },
          });
          return h('div', { style: 'padding:8px;border:1px solid var(--nf-line);border-radius:6px;display:grid;gap:4px' },
            h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:6px' },
              h('b', { textContent: m.title }),
              h('span', { className: 'nf-muted', style: 'font-size:11px', textContent: m.license_short || '' })
            ),
            h('div', { className: 'nf-muted', style: 'font-size:12px', textContent: `${m.category_label} · ${m.triangles ? `${m.triangles.toLocaleString()} tris` : 'GLB'} · by ${m.author?.display_name || 'Creator'}` }),
            h('div', { style: 'display:flex;gap:6px;margin-top:4px' },
              btn,
              h('a', { className: 'nf-btn', href: m.page_url, target: '_blank', rel: 'noopener', textContent: 'Web 3D' })
            )
          );
        }));
      } catch (e) {
        const connectBtn = h('button', { className: 'nf-btn primary', textContent: 'Connect Directed', onclick: () => api.commands.execute('nfgames.directed-connect/connect') });
        listEl.replaceChildren(h('p', { className: 'nf-muted', textContent: e.message }), connectBtn);
      }
    }

    const searchBtn = h('button', { className: 'nf-btn', textContent: 'Search', onclick: load });
    qInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
    catSelect.addEventListener('change', load);

    body.replaceChildren(
      h('div', { style: 'display:flex;gap:6px' }, qInput, searchBtn),
      catSelect,
      listEl
    );
    await load();
  }

  async function renderShare(body) {
    let models = [];
    try {
      const res = await api.fetch('/local-models');
      models = res.models || [];
    } catch (e) {
      body.replaceChildren(h('p', { className: 'nf-muted', textContent: e.message }));
      return;
    }

    if (!models.length) {
      body.replaceChildren(h('p', { className: 'nf-muted', textContent: 'No .glb files found under models/ in this project yet.' }));
      return;
    }

    const modelSel = h('select', { className: 'nf-input', style: 'width:100%' },
      ...models.map((m) => h('option', {
        value: m.path,
        textContent: `${m.path} (${m.triangles ? `${m.triangles.toLocaleString()} tris` : `${Math.round(m.size / 1024)} KB`}${m.refCount ? `, ${m.refCount} refs` : ''})`,
      }))
    );
    const titleInput = h('input', { className: 'nf-input', placeholder: 'e.g. Weathered Oak Barrel', style: 'width:100%' });
    const descInput = h('textarea', { className: 'nf-input', rows: 2, placeholder: 'Short notes on topology, PBR textures, or scale…', style: 'width:100%' });
    const catSel = h('select', { className: 'nf-input', style: 'width:100%' },
      ...CATEGORIES.slice(1).map(([v, l]) => h('option', { value: v, textContent: l }))
    );
    const tagsInput = h('input', { className: 'nf-input', placeholder: 'props, medieval, wood', style: 'width:100%' });
    const provSel = h('select', { className: 'nf-input', style: 'width:100%' },
      h('option', { value: 'human_refined', textContent: 'AI-assisted & human-refined' }),
      h('option', { value: 'hand_made', textContent: 'Hand-made' }),
      h('option', { value: 'ai_generated', textContent: 'AI-generated' })
    );
    const genLicSel = h('select', { className: 'nf-input', style: 'width:100%' },
      h('option', { value: 'clean', textContent: 'Clean / unrestricted (training OK)' }),
      h('option', { value: 'ultrashape_restricted', textContent: 'UltraShape / Hunyuan 2.1 (non-training)' }),
      h('option', { value: 'other', textContent: 'Other / restricted generator' })
    );
    const pubLicSel = h('select', { className: 'nf-input', style: 'width:100%' },
      h('option', { value: 'cc0', textContent: 'CC0 1.0 (Public Domain)' }),
      h('option', { value: 'cc_by', textContent: 'CC BY 4.0 (Attribution)' }),
      h('option', { value: 'commercial_standard', textContent: 'Directed Standard Commercial' })
    );
    const trainBox = h('input', { type: 'checkbox', checked: false });
    const toolsInput = h('input', { className: 'nf-input', value: 'NFGames-Map-Editor, Blender', style: 'width:100%' });

    const autofill = () => {
      const base = modelSel.value.split('/').pop().replace(/\.glb$/i, '').replace(/[-_]+/g, ' ');
      if (!titleInput.value.trim()) titleInput.value = base.replace(/\b\w/g, (c) => c.toUpperCase());
    };
    autofill();
    modelSel.addEventListener('change', () => { titleInput.value = ''; autofill(); });

    const submitBtn = h('button', {
      className: 'nf-btn primary',
      textContent: 'Submit to Directed curation queue',
      onclick: async () => {
        if (!titleInput.value.trim()) { api.ui.toast('Enter a title for this mesh.', 'error'); return; }
        submitBtn.disabled = true;
        submitBtn.textContent = 'Uploading…';
        try {
          const res = await api.fetch('/share', {
            method: 'POST',
            body: JSON.stringify({
              model: modelSel.value,
              title: titleInput.value.trim(),
              description: descInput.value.trim(),
              category: catSel.value,
              tags: tagsInput.value,
              provenance: provSel.value,
              tools_used: toolsInput.value,
              generator_license: genLicSel.value,
              public_license: pubLicSel.value,
              training_opt_in: trainBox.checked,
            }),
          });
          api.ui.toast(`Submitted "${res.mesh.title}" for review!`);
        } catch (e) {
          api.ui.toast(e.message, 'error');
        } finally {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Submit to Directed curation queue';
        }
      },
    });

    const row = (label, el) => h('label', { style: 'display:grid;gap:3px;font-size:12px' }, h('span', { className: 'nf-muted', textContent: label }), el);

    body.replaceChildren(
      row('Local model (.glb + .refs/)', modelSel),
      row('Title', titleInput),
      row('Description', descInput),
      row('Category', catSel),
      row('Tags (comma-separated)', tagsInput),
      row('Provenance', provSel),
      row('Tools used', toolsInput),
      row('Generator license', genLicSel),
      row('Public community license', pubLicSel),
      h('label', { style: 'display:flex;gap:8px;align-items:flex-start;font-size:12px;cursor:pointer' },
        trainBox,
        h('span', { textContent: 'Opt in to Directed 3D model training corpus (only exported if approved & clean license).' })
      ),
      submitBtn
    );
  }

  api.tools.register('library', (el) => {
    panelEl = el;
    renderPanel();
    return () => { panelEl = null; };
  });

  api.commands.register('browse', () => {
    activeTab = 'browse';
    if (panelEl) renderPanel();
    else api.ui.toast('Open the 🧱 Directed Meshes tool on the left rail.');
  });

  api.commands.register('share', () => {
    activeTab = 'share';
    if (panelEl) renderPanel();
    else api.ui.toast('Open the 🧱 Directed Meshes tool on the left rail to share a model.');
  });
}
