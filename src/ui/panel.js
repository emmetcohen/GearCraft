// =============================================================================
// panel.js — tiny helpers to build the right-hand tool panel.
//
// Modes compose the panel out of sections (sliders, toggles, buttons), so a
// future puzzle mode can show different controls (e.g. locked gravity)
// without touching this file.
// =============================================================================

export class Panel {
  constructor(root) {
    this.root = root;
    root.innerHTML = '';
  }

  /** Add a titled box; returns its element so you can append controls. */
  section(title, { id, collapsible = false } = {}) {
    const s = document.createElement('section');
    s.className = 'section';
    if (id) s.id = id;
    if (title) {
      const h = document.createElement('h3');
      h.textContent = title;
      s.appendChild(h);
      if (collapsible) {
        s.classList.add('collapsible');
        h.tabIndex = 0;
        h.addEventListener('click', () => s.classList.toggle('collapsed'));
      }
    }
    this.root.appendChild(s);
    return s;
  }

  /** A row of mutually exclusive buttons: options = [[value, label], ...]. */
  choice(parent, { label, value, options, onChange }) {
    const wrap = document.createElement('div');
    wrap.className = 'choice';
    wrap.innerHTML = `<span>${label}</span>`;
    const row = document.createElement('div');
    row.className = 'seg';
    for (const [v, text] of options) {
      const b = document.createElement('button');
      b.className = `seg-btn${v === value ? ' on' : ''}`;
      b.textContent = text;
      b.addEventListener('click', () => onChange(v));
      row.appendChild(b);
    }
    wrap.appendChild(row);
    parent.appendChild(wrap);
    return wrap;
  }

  /**
   * A labelled range slider.
   * @returns {{ el, set(value) }}
   */
  slider(parent, { label, min, max, step, value, format = (v) => v, onInput }) {
    const wrap = document.createElement('div');
    wrap.className = 'slider';
    wrap.innerHTML = `<label><span>${label}</span><b></b></label><input type="range">`;
    const input = wrap.querySelector('input');
    const out = wrap.querySelector('b');
    Object.assign(input, { min, max, step, value });
    input.setAttribute('aria-label', label);
    const show = () => { out.textContent = format(Number(input.value)); };
    input.addEventListener('input', () => { show(); onInput(Number(input.value)); });
    show();
    parent.appendChild(wrap);
    return { el: input, set(v) { input.value = v; show(); } };
  }

  /** A labelled checkbox. */
  toggle(parent, { label, checked, onChange, title }) {
    const l = document.createElement('label');
    l.className = 'toggle';
    if (title) l.title = title;
    l.innerHTML = `<input type="checkbox"><span>${label}</span>`;
    const input = l.querySelector('input');
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    parent.appendChild(l);
    return { el: input, set(v) { input.checked = v; } };
  }

  /** A row of buttons: [{ label, title, onClick, className }] */
  buttons(parent, defs) {
    const row = document.createElement('div');
    row.className = 'btn-row';
    const els = defs.map((d) => {
      const b = document.createElement('button');
      b.className = `btn small ${d.className ?? ''}`;
      b.textContent = d.label;
      if (d.title) b.title = d.title;
      b.addEventListener('click', d.onClick);
      row.appendChild(b);
      return b;
    });
    parent.appendChild(row);
    return els;
  }
}
