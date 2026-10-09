// Undo / redo for layout edits: a stack of snapshots (layout.js `snapshot`). Rapid edits to the same
// field (typing in a box, dragging a slider) collapse into one step.
export class History {
  constructor(limit = 200) { this.limit = limit; this.reset(null); }

  reset(state) { this.stack = state ? [state] : []; this.i = this.stack.length - 1; this.lastKey = null; this.lastAt = 0; }

  /** Record the state after an edit. `key` names the field being edited so a burst of edits to it becomes one step. */
  push(state, key = null, now = Date.now()) {
    const top = this.i === this.stack.length - 1 && this.i > 0;
    if (key && key === this.lastKey && top && now - this.lastAt < 1200) this.stack[this.i] = state;
    else {
      this.stack.splice(this.i + 1);
      this.stack.push(state);
      if (this.stack.length > this.limit) this.stack.splice(0, this.stack.length - this.limit);
      this.i = this.stack.length - 1;
    }
    this.lastKey = key; this.lastAt = now;
  }

  get canUndo() { return this.i > 0; }
  get canRedo() { return this.i < this.stack.length - 1; }
  undo() { if (!this.canUndo) return null; this.lastKey = null; return this.stack[--this.i]; }
  redo() { if (!this.canRedo) return null; this.lastKey = null; return this.stack[++this.i]; }
}
