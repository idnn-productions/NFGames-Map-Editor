// The workbench's layout, kept in this browser: which panels are hidden and how wide the side panel and the Inspector
// are. The bottom panel is never gone: "hidden" for it means resting as a one-line strip of its tabs, which is how it
// starts. Widths are clamped so a panel is at least MIN wide and the documents always keep ROOM.
export const DEFAULTS = Object.freeze({ hidden: Object.freeze(['bottom']), side: 260, inspector: 280 });
export const MIN = 200, ROOM = 320, RAIL = 46;
const PANELS = ['side', 'inspector', 'bottom'];
const width = (v, fallback) => (Number.isFinite(v) && v > 0 ? Math.round(v) : fallback);

/** The widths to use in a window this wide. Too narrow for both panels: the Inspector is 0 (not shown). */
export function clampWidths({ side, inspector } = {}, windowWidth) {
  let s = Math.max(MIN, width(side, DEFAULTS.side)), i = Math.max(MIN, width(inspector, DEFAULTS.inspector));
  const room = windowWidth - RAIL - ROOM;
  if (room < MIN * 2) return { side: MIN, inspector: 0 };
  if (s + i > room) {   // both shrink in proportion, neither below MIN
    const k = room / (s + i); s = Math.round(s * k); i = Math.round(i * k);
    if (s < MIN) { s = MIN; i = room - MIN; } else if (i < MIN) { i = MIN; s = room - MIN; } else i = room - s;
  }
  return { side: s, inspector: i };
}

/** The kept layout from its text. Before widths were kept, the text was the list of hidden panels. */
export function readLayout(text) {
  let j; try { j = JSON.parse(text); } catch { j = null; }
  if (Array.isArray(j)) return { ...DEFAULTS, hidden: PANELS.filter((p) => p === 'bottom' || j.includes(p)) };
  if (!j || typeof j !== 'object') return { ...DEFAULTS, hidden: [...DEFAULTS.hidden] };
  return { hidden: PANELS.filter((p) => Array.isArray(j.hidden) && j.hidden.includes(p)), side: width(j.side, DEFAULTS.side), inspector: width(j.inspector, DEFAULTS.inspector) };
}
export const writeLayout = ({ hidden, side, inspector }) => JSON.stringify({ hidden, side, inspector });
