// =============================================================================
// history.js — undo/redo by SNAPSHOTS.
//
// Because the build is small plain data, the simplest robust undo is to keep
// a copy of the whole build after every change. No per-action "inverse"
// code to get wrong. We store JSON strings (cheap to compare and copy).
// =============================================================================

export class History {
  constructor(limit = 200) {
    this.limit = limit;
    this.stack = [];   // snapshots (JSON strings)
    this.index = -1;   // which snapshot is "now"
  }

  /** Forget everything and start from this build. */
  reset(build) {
    this.stack = [JSON.stringify(build)];
    this.index = 0;
  }

  /** Record the build after a change. Drops any redo future. */
  push(build) {
    const snap = JSON.stringify(build);
    if (snap === this.stack[this.index]) return; // nothing actually changed
    this.stack.length = this.index + 1;
    this.stack.push(snap);
    if (this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
  }

  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.stack.length - 1; }

  /** Step back; returns a fresh copy of the older build (or null). */
  undo() {
    if (!this.canUndo) return null;
    this.index--;
    return JSON.parse(this.stack[this.index]);
  }

  redo() {
    if (!this.canRedo) return null;
    this.index++;
    return JSON.parse(this.stack[this.index]);
  }
}
