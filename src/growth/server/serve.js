#!/usr/bin/env node
// Launcher (local preview only): npm run growth -> http://127.0.0.1:4413
// Binds to the loopback interface; there is no hosted/staging mode for Growth yet (no access token layer),
// so it must not be exposed. Optional: GROWTH_PORT.

import http from 'node:http';
import { createGrowthApp } from './app.js';

const port = Number(process.env.GROWTH_PORT || 4413);
const handler = createGrowthApp();
http.createServer(handler).listen(port, '127.0.0.1', () => {
  console.log(`Nordla Growth (Overview, demonstration data) running at http://127.0.0.1:${port}`);
});
