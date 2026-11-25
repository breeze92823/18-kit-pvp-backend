import { listen } from "@colyseus/tools";

import app from "./app.config.js";
import { connectDb } from "./db.js";
import { installBoxityReporters } from "./boxity/index.js";
import { installRoomReporter } from "./legion-room-reporter.js";

// Player-progress persistence (src/db.ts) connects before the room accepts
// players; connectDb() itself never throws or hangs (degrades to "no persistence").
await connectDb();

// Listens on PORT (or 2567).
await listen(app);

// Boxity hosting only (all no-ops without BLOXITY_REPORT_TOKEN / BLOXITY_GAME_ID / MATCHMAKER_REPORT_URL):
// the cross-pod room directory ("Open Rooms", join-by-id), profile stats, leaderboards and badges.
installRoomReporter();
installBoxityReporters();
