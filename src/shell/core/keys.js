// Key chords: "Mod+Shift+S" (Mod is ⌘ on a Mac, Ctrl elsewhere), matched against keydown events and shown as text.
const MODS = ['ctrl', 'meta', 'alt', 'shift'];
const NAMES = { esc: 'escape', del: 'delete', return: 'enter', space: ' ', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright' };

export function parseKeys(text, { mac = false } = {}) {
  const parts = String(text).split('+').map((p) => p.trim()).filter(Boolean), chord = { ctrl: false, meta: false, alt: false, shift: false, key: '' };
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'mod') chord[mac ? 'meta' : 'ctrl'] = true;
    else if (MODS.includes(l)) chord[l] = true;
    else if (chord.key) throw new Error(`two keys in "${text}"`);
    else chord.key = NAMES[l] || l;
  }
  if (!chord.key) throw new Error(`no key in "${text}"`);
  return chord;
}
export const matches = (chord, e) => !!e && e.ctrlKey === chord.ctrl && e.metaKey === chord.meta && e.altKey === chord.alt && e.shiftKey === chord.shift && String(e.key).toLowerCase() === chord.key;
export function showKeys(chord, { mac = false } = {}) {
  const k = chord.key.length === 1 ? chord.key.toUpperCase() : chord.key[0].toUpperCase() + chord.key.slice(1);
  return mac ? `${chord.ctrl ? '⌃' : ''}${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${chord.meta ? '⌘' : ''}${k}`
    : [chord.ctrl && 'Ctrl', chord.alt && 'Alt', chord.shift && 'Shift', chord.meta && 'Meta', k].filter(Boolean).join('+');
}
