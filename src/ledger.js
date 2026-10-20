import fs from "node:fs";
import path from "node:path";

export const LEDGER_SCHEMA = "process-ledger.v1";
export const LIVE_SCHEMA = "process-ledger.live.v1";
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_ROLE_LENGTH = 80;
export const MAX_ACTION_LENGTH = 40;
export const MAX_SOURCE_LENGTH = 160;
export const MIN_PID = 2;
export const DEFAULT_ACTION = "start";
export const LIVE_CORRUPT_CODE = "LIVE_CORRUPT";
export const HISTORY_FILE_NAME = "process-ledger.jsonl";
export const LIVE_FILE_NAME = "process-ledger-live.json";

const TEMP_FILE_PREFIX = "process-ledger-live";
const TEMP_PATH_ATTEMPTS = 16;
const LIVE_JSON_INDENT = 2;
const LINE_SEPARATOR_BYTES = 1;

export class LedgerReadError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "LedgerReadError";
    this.code = LIVE_CORRUPT_CODE;
  }
}

export function createLedger(root, options) {
  if (typeof root !== "string") {
    throw new TypeError("root must be a string");
  }

  const maxBytes = resolveMaxBytes(options);
  const jsonlPath = path.join(root, HISTORY_FILE_NAME);
  const livePath = path.join(root, LIVE_FILE_NAME);
  const writeState = { sequence: 0 };

  return {
    register(input) {
      const row = registrationRow(input);
      if (row == null) {
        return false;
      }

      const live = readLiveFile(livePath);
      fs.mkdirSync(root, { recursive: true });
      fs.appendFileSync(jsonlPath, `${JSON.stringify(row)}\n`, "utf8");
      trimHistory(jsonlPath, maxBytes);
      live.schema = LIVE_SCHEMA;
      live.at = row.at;
      live.roles[row.role] = {
        pid: row.pid,
        at: row.at,
        action: row.action,
        source: row.source
      };
      writeLiveFile(root, livePath, live, writeState);
      return true;
    },

    live() {
      return readLiveFile(livePath);
    },

    livePids() {
      return pidsFromLive(readLiveFile(livePath));
    }
  };
}

export function planRoleRecovery(role, entries, alive) {
  if (!Array.isArray(entries)) {
    throw new TypeError("entries must be an array");
  }
  if (typeof alive !== "function") {
    throw new TypeError("alive must be a function");
  }

  const requestedRole = typeof role === "string" ? role : "";
  const scoped = entries.filter((entry) => entryBelongsToRole(entry, requestedRole));
  const living = scoped.filter((entry) => alive(entry.pid));
  if (living.length === 0) {
    return { keep: null, kill: [], start: true };
  }

  const ranked = living.slice().sort((left, right) => compareRoleEntries(left, right));
  return {
    keep: ranked[0].pid,
    kill: ranked.slice(1).map((entry) => entry.pid),
    start: false
  };
}

export function planStormRecovery(roles, caps, alive) {
  if (roles == null || typeof roles !== "object" || Array.isArray(roles)) {
    throw new TypeError("roles must be an object");
  }
  if (caps == null || typeof caps !== "object" || Array.isArray(caps)) {
    throw new TypeError("caps must be an object");
  }
  if (typeof alive !== "function") {
    throw new TypeError("alive must be a function");
  }

  const kills = [];
  for (const role of Object.keys(caps)) {
    const group = roles[role];
    const entries = group == null ? [] : group;
    const living = entries.filter((entry) => alive(entry.pid));
    const ranked = living.slice().sort((left, right) => compareStartedAt(left, right));
    const overflow = Math.max(0, ranked.length - caps[role]);
    for (let index = 0; index < overflow; index += 1) {
      kills.push({ role, pid: ranked[index].pid });
    }
  }
  return kills;
}

function resolveMaxBytes(options) {
  if (options == null) {
    return DEFAULT_MAX_BYTES;
  }
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  if (options.maxBytes == null) {
    return DEFAULT_MAX_BYTES;
  }
  if (
    typeof options.maxBytes !== "number" ||
    !Number.isFinite(options.maxBytes) ||
    options.maxBytes <= 0
  ) {
    throw new TypeError("maxBytes must be a finite number greater than 0");
  }
  return options.maxBytes;
}

function registrationRow(input) {
  if (input == null || typeof input !== "object") {
    throw new TypeError("input must be an object");
  }

  const role = boundedText(input.role, "", MAX_ROLE_LENGTH);
  const pid = Number(input.pid);
  const action = boundedText(input.action, DEFAULT_ACTION, MAX_ACTION_LENGTH);
  if (role === "" || !Number.isInteger(pid) || pid < MIN_PID) {
    return null;
  }

  return {
    schema: LEDGER_SCHEMA,
    at: input.at || new Date().toISOString(),
    role,
    pid,
    action,
    source: boundedText(input.source, "", MAX_SOURCE_LENGTH)
  };
}

function boundedText(value, fallback, maxLength) {
  const text = value ? String(value) : fallback;
  return text.slice(0, maxLength);
}

function readLiveFile(livePath) {
  let raw;
  try {
    raw = fs.readFileSync(livePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return emptyLive();
    }
    throw error;
  }
  return parseLive(raw);
}

function emptyLive() {
  return {
    schema: LIVE_SCHEMA,
    at: "",
    roles: {}
  };
}

function parseLive(raw) {
  const text = raw.replace(/^\uFEFF/, "");
  if (text.trim() === "") {
    throw new LedgerReadError("live snapshot is empty");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new LedgerReadError("live snapshot is not valid JSON", error);
  }

  if (!isRoleMapSnapshot(parsed)) {
    throw new LedgerReadError("live snapshot does not contain a roles object");
  }
  return parsed;
}

function isRoleMapSnapshot(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const roles = value.roles;
  return roles != null && typeof roles === "object" && !Array.isArray(roles);
}

function pidsFromLive(live) {
  const roles = live.roles;
  return Object.keys(roles)
    .map((roleName) => pidFromRole(roles[roleName]))
    .filter((pid) => Number.isInteger(pid) && pid >= MIN_PID);
}

function pidFromRole(entry) {
  if (entry == null || typeof entry !== "object") {
    return Number.NaN;
  }
  return Number(entry.pid);
}

function writeLiveFile(root, livePath, live, writeState) {
  const payload = `${JSON.stringify(live, null, LIVE_JSON_INDENT)}\n`;
  let lastExistError = null;

  for (let attempt = 0; attempt < TEMP_PATH_ATTEMPTS; attempt += 1) {
    writeState.sequence += 1;
    const tempPath = path.join(
      root,
      `${TEMP_FILE_PREFIX}.${process.pid}.${writeState.sequence}.json.next`
    );
    try {
      fs.writeFileSync(tempPath, payload, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      lastExistError = error;
      continue;
    }

    try {
      fs.renameSync(tempPath, livePath);
      return;
    } catch (error) {
      removeTempFile(tempPath);
      throw error;
    }
  }

  if (lastExistError === null) {
    throw new Error("could not allocate a live snapshot temp path");
  }
  throw lastExistError;
}

function removeTempFile(tempPath) {
  try {
    fs.unlinkSync(tempPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function trimHistory(jsonlPath, maxBytes) {
  const stat = fs.statSync(jsonlPath);
  if (stat.size <= maxBytes) {
    return;
  }

  const lines = fs
    .readFileSync(jsonlPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
  const kept = [];
  let size = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const nextSize = line.length + LINE_SEPARATOR_BYTES;
    if (kept.length > 0 && size + nextSize > maxBytes) {
      break;
    }
    kept.push(line);
    size += nextSize;
  }
  if (kept.length === 0) {
    return;
  }
  kept.reverse();
  fs.writeFileSync(jsonlPath, `${kept.join("\n")}\n`, "utf8");
}

function entryBelongsToRole(entry, requestedRole) {
  if (entry == null || typeof entry !== "object" || typeof entry.role !== "string") {
    return true;
  }
  return entry.role === requestedRole;
}

function compareRoleEntries(left, right) {
  const leftListening = Boolean(left.listening);
  const rightListening = Boolean(right.listening);
  if (rightListening !== leftListening) {
    return Number(rightListening) - Number(leftListening);
  }
  return compareStartedAt(left, right);
}

function compareStartedAt(left, right) {
  return String(left.startedAt).localeCompare(String(right.startedAt));
}
