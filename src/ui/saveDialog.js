// =============================================================================
// saveDialog.js — the Save / Load window: named slots, examples, file
// export/import.
// =============================================================================
import { listSlots, saveSlot, loadSlot, deleteSlot, exportFile, importFile } from '../save/storage.js';
import { EXAMPLES } from '../save/examples.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createSaveDialog(app) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <h2>💾 Save &amp; Load</h2>
    <div style="display:flex;gap:6px">
      <input type="text" id="save-name" placeholder="Name your machine" maxlength="40" aria-label="Save name">
      <button class="btn btn-go" id="save-go">Save</button>
    </div>
    <ul class="slot-list" id="slot-list"></ul>
    <h3 style="margin:8px 0 4px">Examples</h3>
    <ul class="slot-list" id="example-list"></ul>
    <div class="dialog-foot">
      <div class="btn-row">
        <button class="btn" id="export-go" title="Download this build as a .json file">⬇ Export file</button>
        <button class="btn" id="import-go" title="Load a .json build file">⬆ Import file</button>
      </div>
      <button class="btn" id="close-go">Close</button>
    </div>`;
  document.body.appendChild(dlg);
  const $ = (id) => dlg.querySelector(`#${id}`);
  const nameInput = $('save-name');

  const renderSlots = () => {
    const slots = listSlots();
    const ul = $('slot-list');
    ul.innerHTML = slots.length ? '' : '<li><span class="slot-name" style="opacity:.6">No saves yet.</span></li>';
    for (const s of slots) {
      const li = document.createElement('li');
      const when = s.savedAt ? new Date(s.savedAt).toLocaleString() : '';
      li.innerHTML = `<span class="slot-name">${esc(s.name)}<small>${s.count} parts · ${esc(when)}</small></span>
        <button class="btn small btn-go" data-act="load">Load</button>
        <button class="btn small btn-danger" data-act="del" title="Delete this save">🗑</button>`;
      li.querySelector('[data-act=load]').addEventListener('click', () => {
        try {
          const { build, dropped } = loadSlot(s.name);
          app.setBuild(build);
          app.currentName = s.name;
          app.toast(`Loaded "${s.name}"${dropped ? ` (${dropped} unknown parts skipped)` : ''}`);
          dlg.close();
        } catch (e) { app.toast(e.message); }
      });
      li.querySelector('[data-act=del]').addEventListener('click', () => {
        if (!confirm(`Delete the save "${s.name}"?`)) return;
        deleteSlot(s.name);
        renderSlots();
      });
      ul.appendChild(li);
    }
  };

  const exUl = $('example-list');
  for (const ex of EXAMPLES) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="slot-name">${esc(ex.name)}<small style="white-space:normal">${esc(ex.blurb)}</small></span>
      <button class="btn small" data-act="load">Open</button>`;
    li.querySelector('button').addEventListener('click', () => {
      app.setBuild(ex.build());
      if (ex.camera) Object.assign(app.camera, ex.camera);
      app.currentName = ex.name;
      app.toast(`Example: ${ex.name}`);
      dlg.close();
    });
    exUl.appendChild(li);
  }

  $('save-go').addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    const build = app.preplay ?? app.build; // while running, save the pre-play build
    if (saveSlot(name, build)) {
      app.currentName = name;
      app.toast(`Saved "${name}"`);
      renderSlots();
    } else {
      app.toast('Could not save: browser storage is blocked or full. Try Export instead.');
    }
  });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('save-go').click(); });

  $('export-go').addEventListener('click', () => {
    exportFile(app.preplay ?? app.build, nameInput.value.trim() || app.currentName || 'my-machine');
  });
  $('import-go').addEventListener('click', async () => {
    try {
      const { build, dropped, name } = await importFile();
      app.setBuild(build);
      app.currentName = name;
      app.toast(`Imported${name ? ` "${name}"` : ''}${dropped ? ` (${dropped} unknown parts skipped)` : ''}`);
      dlg.close();
    } catch (e) { app.toast(e.message, 3500); }
  });
  $('close-go').addEventListener('click', () => dlg.close());

  return {
    open() {
      nameInput.value = app.currentName && !EXAMPLES.some((e) => e.name === app.currentName) ? app.currentName : '';
      renderSlots();
      dlg.showModal();
      nameInput.focus();
    },
  };
}
