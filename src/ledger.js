import fs from "node:fs";
import path from "node:path";

export const LEDGER_SCHEMA = "process-ledger.v1";
export const LIVE_SCHEMA = "process-ledger.live.v1";

export function createLedger(root, options) {
  const maxBytes = options && options.maxBytes ? options.maxBytes : 8 * 1024 * 1024;
  const jsonlPath = path.join(root, "process-ledger.jsonl");
  const livePath = path.join(root, "process-ledger-live.json");

  function readLive() {
    try {
      const raw = fs.readFileSync(livePath, "utf8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(raw);
      if (parsed && parsed.roles && typeof parsed.roles === "object") return parsed;
    } catch (err) {}
    return { schema: LIVE_SCHEMA, at: "", roles: {} };
  }

  function writeLive(live) {
    const next = livePath + ".next";
    fs.writeFileSync(next, JSON.stringify(live, null, 2) + "\n", "utf8");
    fs.renameSync(next, livePath);
  }

  function trim() {
    try {
      const stat = fs.statSync(jsonlPath);
      if (stat.size <= maxBytes) return;
      const lines = fs.readFileSync(jsonlPath, "utf8").split("\n").filter((line) => line.trim());
      const kept = [];
      let size = 0;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const next = lines[i].length + 1;
        if (kept.length > 0 && size + next > maxBytes) break;
        kept.unshift(lines[i]);
        size += next;
      }
      if (kept.length === 0) return;
      fs.writeFileSync(jsonlPath, kept.join("\n") + "\n", "utf8");
    } catch (err) {}
  }

  return {
    register(input) {
      const role = String(input.role || "").slice(0, 80);
      const pid = Number(input.pid);
      const action = String(input.action || "start").slice(0, 40);
      if (!role || !Number.isInteger(pid) || pid <= 1) return false;
      fs.mkdirSync(root, { recursive: true });
      const row = {
        schema: LEDGER_SCHEMA,
        at: input.at || new Date().toISOString(),
        role,
        pid,
        action,
        source: String(input.source || "").slice(0, 160)
      };
      fs.appendFileSync(jsonlPath, JSON.stringify(row) + "\n", "utf8");
      trim();
      const live = readLive();
      live.schema = LIVE_SCHEMA;
      live.at = row.at;
      live.roles[role] = { pid, at: row.at, action, source: row.source };
      writeLive(live);
      return true;
    },
    live() {
      return readLive();
    },
    livePids() {
      const roles = readLive().roles;
      return Object.keys(roles)
        .map((role) => Number(roles[role].pid))
        .filter((pid) => Number.isInteger(pid) && pid > 1);
    }
  };
}

export function planRoleRecovery(role, entries, alive) {
  const living = entries.filter((entry) => alive(entry.pid));
  if (living.length === 0) return { keep: null, kill: [], start: true };
  const ranked = living.slice().sort((a, b) => {
    if (Boolean(b.listening) !== Boolean(a.listening)) return Number(b.listening) - Number(a.listening);
    return String(a.startedAt).localeCompare(String(b.startedAt));
  });
  const keep = ranked[0].pid;
  return {
    keep,
    kill: ranked.slice(1).map((entry) => entry.pid),
    start: false
  };
}

export function planStormRecovery(roles, caps, alive) {
  const kills = [];
  for (const role of Object.keys(caps)) {
    const living = (roles[role] || []).filter((entry) => alive(entry.pid));
    const ranked = living.slice().sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const overflow = Math.max(0, ranked.length - caps[role]);
    for (let i = 0; i < overflow; i += 1) kills.push({ role, pid: ranked[i].pid });
  }
  return kills;
}
