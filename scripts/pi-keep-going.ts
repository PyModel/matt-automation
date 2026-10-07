// Pi extension: the Stop-hook half of to-auto-guard.mjs for pi. When an agent run is about to settle in a session that
// registered an active to-auto run (runs.json `agent` = this session id), it asks `goal.mjs keep-going` and, if the run's
// control plane moved since the last nudge, appends that reason and continues. Esc (aborted) and errors always win.
// Install: ln -s <repo>/scripts/pi-keep-going.ts ~/.pi/agent/extensions/to-auto-keep-going.ts (loaded at session start).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GOAL = path.join(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), "goal.mjs");

export default function (pi: any) {
  pi.on("agent_before_settle", async (event: any, ctx: any) => {
    if (event.outcome !== "completed") return; // Esc (aborted) and errors end the turn
    const id = ctx?.sessionManager?.getSessionId?.();
    if (typeof id !== "string" || !id) return;
    try {
      const r = await pi.exec("node", [GOAL, "keep-going", "--agent", id], { timeout: 30_000 });
      const verdict = JSON.parse(r.stdout);
      if (!verdict.continue) return;
      return {
        entries: [{ type: "custom_message", customType: "to-auto-keep-going", content: verdict.reason, display: true }],
        continue: true,
      };
    } catch {
      return; // fails open: a broken goal.mjs lets the turn end
    }
  });
}
