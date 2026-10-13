// =============================================================================
// puzzle.js — PUZZLE MODE (not built yet: intentional stub).
//
// When it's time to add puzzles, this file exports an object with the same
// shape as sandboxMode (see sandbox.js), plus puzzle-specific pieces:
//
//   levels / loadLevel(app, level)
//       Build the starting world from a level file: pre-placed fixed parts
//       (locked, not deletable), goal zones, and a parts budget.
//   partFilter(def)
//       Only allow the parts the level hands out.
//   anchor rules
//       Unlike sandbox, anchors may only go on marked spots, so snapPart()
//       would receive an "allowed anchor spots" list from the mode.
//   checkGoal(app)
//       Called every frame while playing, e.g. "the ball reached the flag" or
//       "the output gear turns at 60 RPM". Uses app.sim.readout(uid).
//   scoring
//       Parts used, time to solve, etc.
//
// Nothing in src/parts, src/physics or src/core needs to change for this:
// those modules never import a mode.
// =============================================================================

export const puzzleMode = null; // not implemented yet
