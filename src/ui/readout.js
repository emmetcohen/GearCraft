// =============================================================================
// readout.js — the small floating card next to the selected part showing
// RPM, torque and gear ratio.
// =============================================================================

const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

/**
 * @param el    the readout <div>
 * @param info  null to hide, or { name, rpm, torque, ratio, load, note, live }
 * @param pos   { x, y } screen position to sit beside
 */
export function showReadout(el, info, pos) {
  if (!info) { el.hidden = true; return; }
  el.hidden = false;
  const rows = [];
  const row = (k, v) => rows.push(`<div class="row"><span>${k}</span><b>${v}</b></div>`);
  if (info.rpm !== undefined) row(info.live ? 'RPM' : 'RPM (no load)', fmt(info.rpm));
  if (info.torque !== undefined) row(info.live ? 'Torque' : 'Max torque', `${fmt(info.torque)} N·m`);
  if (info.ratio != null && info.ratio !== 0) {
    // Gear ratio as engineers write it: input turns : output turns.
    // 2.00 : 1 means the motor turns twice for each turn of this part (slower, stronger).
    const gr = 1 / Math.abs(info.ratio);
    row('Gear ratio', `${fmt(gr, 2)} : 1`);
    row('Direction', info.ratio < 0 ? 'reversed ↺' : 'same ↻');
  }
  if (info.load != null) row('Load', `${Math.round(info.load * 100)}%`);
  el.innerHTML = `<h4>${info.name}</h4>${rows.join('')}${info.note ? `<div class="note">${info.note}</div>` : ''}`;

  // Keep the card inside the stage.
  const parent = el.parentElement.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  let x = pos.x + 24, y = pos.y - h / 2;
  if (x + w > parent.width - 8) x = pos.x - w - 24;
  x = Math.max(8, Math.min(parent.width - w - 8, x));
  y = Math.max(8, Math.min(parent.height - h - 8, y));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}
