// =============================================================================
// main.js — entry point. Picks a game mode and starts the app.
// (Only sandbox exists for now; puzzle mode will slot in here later.)
// =============================================================================
import { App } from './app.js';
import { sandboxMode } from './modes/sandbox.js';

const app = new App(sandboxMode);
app.start();

// Handy for poking around in the browser console: `gearcraft.build`, etc.
window.gearcraft = app;
