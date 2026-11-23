// Which part of the shown page a workbench region shows. A framed page (the map editor, the model viewer) lends parts
// of itself by region: { side?, inspector?, bottom? }. The side panel shows the page's part only while no rail tool is
// picked; the Inspector and the bottom panel show theirs whenever the page's tab is the one shown.
export function lentFor(region, { activeTool = null, frame = null } = {}) {
  if (!frame || !frame[region]) return null;
  if (region === 'side' && activeTool) return null;
  return frame[region];
}
