// Directed Games status bar indicator & connect dialog.
import { h } from '/shell/ui.js';

export function activate(api) {
  let state = { connected: false, site: 'https://directedgames.com', user: null };
  let statusEl = null;

  async function refresh() {
    try {
      state = await api.fetch('/status');
    } catch (e) {
      state = { connected: false, error: e.message };
    }
    drawStatus();
  }

  function drawStatus() {
    if (!statusEl) return;
    const label = state.connected && state.user
      ? `● Directed: ${state.user.display_name || state.user.login}`
      : '○ Connect Directed';
    const btn = h('button', {
      className: 'nf-btn',
      style: 'padding:2px 8px;font-size:12px;line-height:1.3',
      textContent: label,
      title: state.connected ? `Connected to ${state.site}` : 'Connect your Directed Games account to share & import 3D meshes',
      onclick: () => openConnectDialog(),
    });
    statusEl.replaceChildren(btn);
  }

  async function openConnectDialog() {
    await refresh();
    if (state.connected && state.user) {
      const body = h('div', { style: 'display:grid;gap:10px' },
        h('p', { textContent: `Signed in as ${state.user.display_name} (@${state.user.login}) on ${state.site}.` }),
        h('p', { className: 'nf-muted', textContent: `Shared meshes: ${state.mesh_count ?? 0}. Your scoped key is stored in your OS vault and can be revoked anytime from directedgames.com/account/.` })
      );
      const act = await api.ui.dialog({
        title: 'Directed Games Account',
        body,
        actions: [
          { id: 'disconnect', label: 'Disconnect', variant: 'danger' },
          { id: 'close', label: 'Close', variant: 'primary' },
        ],
      });
      if (act === 'disconnect') {
        await api.fetch('/disconnect', { method: 'POST', body: '{}' });
        api.ui.toast('Disconnected from Directed Games.');
        await refresh();
      }
      return;
    }

    const codeInput = h('textarea', {
      className: 'nf-input',
      rows: 3,
      placeholder: '{"site":"https://directedgames.com","login":"...","key":"..."}',
      style: 'width:100%;font-family:monospace;font-size:12px',
    });

    const browserBtn = h('button', {
      className: 'nf-btn primary',
      textContent: 'Connect in browser (1-click)',
      onclick: async () => {
        try {
          const { url } = await api.fetch('/begin', { method: 'POST', body: '{}' });
          window.open(url, '_blank', 'noopener');
          api.ui.toast('Authorize in your browser to finish connecting.');
        } catch (e) {
          api.ui.toast(e.message, 'error');
        }
      },
    });

    const body = h('div', { style: 'display:grid;gap:12px' },
      h('p', { textContent: 'Link your Directed Games account to browse curated community meshes, 1-click import GLBs into models/, and share your own creations.' }),
      h('div', {}, browserBtn),
      h('hr', { style: 'border:0;border-top:1px solid var(--nf-line);width:100%' }),
      h('p', { className: 'nf-muted', textContent: 'Or paste a manual connection code from directedgames.com/account/connect/:' }),
      codeInput
    );

    const act = await api.ui.dialog({
      title: 'Connect Directed Games',
      body,
      actions: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'manual', label: 'Save pasted code', variant: 'primary' },
      ],
    });

    if (act === 'manual' && codeInput.value.trim()) {
      try {
        const res = await api.fetch('/manual', { method: 'POST', body: JSON.stringify({ code: codeInput.value.trim() }) });
        api.ui.toast(`Connected as ${res.user?.display_name || res.user?.login}!`);
        await refresh();
      } catch (e) {
        api.ui.toast(e.message, 'error');
      }
    }
  }

  api.statusItems.register('account', (el) => {
    statusEl = el;
    drawStatus();
    refresh();
  });

  api.commands.register('connect', () => openConnectDialog());
  api.commands.register('disconnect', async () => {
    await api.fetch('/disconnect', { method: 'POST', body: '{}' });
    api.ui.toast('Disconnected from Directed Games.');
    await refresh();
  });

  api.events.on('nfgames.directed-connect/changed', () => refresh());
  api.events.on('services/changed', () => refresh());
}
