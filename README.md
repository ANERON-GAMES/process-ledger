# process-ledger

One live process per role, with an append-only history of every start.

A supervisor that only checks "is HTTP 200" will leave a hung copy running and then start a second copy. A supervisor that only checks a pid file will trust a process that failed to bind its port. This ledger records the start, then answers a separate question: which pid to keep, which duplicates to stop, and whether a start is still allowed.

The history is a JSON line file. The live snapshot is one JSON object, rewritten through a temporary file and a rename. Recovery is a pure plan. The caller decides which pids are still alive, and the caller is the one that stops or starts a process.

## Install

The package is an ES module. It needs Node.js 20 or newer. It has no runtime dependencies. The only runtime imports are `node:fs` and `node:path`. The package name is `@aneron/process-ledger`. It is not published to the npm registry.

Clone this repository and run the tests:

```bash
git clone https://github.com/ANERON-GAMES/process-ledger.git
cd process-ledger
npm install
npm test
```

`npm test` runs `node --test`. `npm run lint` runs ESLint. `npm run format:check` runs Prettier.

Install it as a dependency from the git repository:

```bash
npm install github:ANERON-GAMES/process-ledger
```

```js
import { createLedger, planRoleRecovery, planStormRecovery } from "@aneron/process-ledger";
```

Code in this repository imports the same entry point with `./src/index.js`.

## Usage

`createLedger` stores files under the directory you pass. `register` appends one history row and replaces that role in the live snapshot. A second start for the same role keeps both history rows and leaves one live pid.

```js
import { createLedger, planRoleRecovery, planStormRecovery } from "@aneron/process-ledger";

const ledger = createLedger("./state");
ledger.register({ role: "gateway", pid: 4100, action: "start", at: "2026-09-30T20:00:00.000Z" });
ledger.register({ role: "gateway", pid: 4108, action: "start", at: "2026-09-30T20:01:00.000Z" });

ledger.live().roles.gateway.pid;
ledger.livePids();
```

`live().roles.gateway.pid` is `4108`. `livePids()` is `[4108]`. The history file has two lines.

`register` returns `false`, and writes nothing, when the role is empty or the pid is below 2. Pid `0` and pid `1` are both refused. A pid of `2` is the first value that is recorded.

```js
ledger.register({ role: "", pid: 4100 });
ledger.register({ role: "gateway", pid: 0 });
ledger.register({ role: "gateway", pid: 1 });
```

Each of those calls returns `false`. The history file and the live snapshot are unchanged.

The listener wins over a newer process that never bound the port. If every recorded pid is dead, the plan starts exactly one and names nobody to kill.

```js
const plan = planRoleRecovery(
  "gateway",
  [
    { pid: 4100, startedAt: "2026-09-15T11:26:00.000Z", listening: true },
    { pid: 4188, startedAt: "2026-09-23T14:51:00.000Z", listening: false }
  ],
  (pid) => pid === 4100 || pid === 4188
);
```

`plan.keep` is `4100`. `plan.kill` is `[4188]`. `plan.start` is `false`.

`planStormRecovery` applies a separate cap to each role in one map and stops the oldest overflow. A role that is not listed in the caps is left alone.

```js
const kills = planStormRecovery(
  {
    shell: [
      { pid: 11, startedAt: "2026-09-30T19:00:00.000Z" },
      { pid: 12, startedAt: "2026-09-30T19:01:00.000Z" },
      { pid: 13, startedAt: "2026-09-30T19:02:00.000Z" }
    ],
    worker: [
      { pid: 21, startedAt: "2026-09-30T18:00:00.000Z" },
      { pid: 22, startedAt: "2026-09-30T19:03:00.000Z" }
    ]
  },
  { shell: 2, worker: 1 },
  () => true
);
```

`kills` is `[{ role: "shell", pid: 11 }, { role: "worker", pid: 21 }]`. The shell keeps two processes. The worker keeps one. The oldest `startedAt` in each role is the one that stops.

## API reference

`createLedger` reads and writes the filesystem. It uses `node:fs` and `node:path` only. It does not open a socket, spawn a process, or send a signal. `planRoleRecovery` and `planStormRecovery` are pure. They do not read the clock, the filesystem, or the process table. The caller passes the `alive` predicate.

Files for one ledger:

| File                              | Constant            | Contents                                                                               |
| --------------------------------- | ------------------- | -------------------------------------------------------------------------------------- |
| `<root>/process-ledger.jsonl`     | `HISTORY_FILE_NAME` | One JSON object per line. Append-only, then trimmed from the front on a line boundary. |
| `<root>/process-ledger-live.json` | `LIVE_FILE_NAME`    | The current snapshot. One role, one pid.                                               |

A missing live file is an empty ledger. A live file that is empty, not JSON, or has no `roles` object throws `LedgerReadError`. That failure is not reported as an empty ledger.

### Constants

| Export              | Value                        | Meaning                                                            |
| ------------------- | ---------------------------- | ------------------------------------------------------------------ |
| `LEDGER_SCHEMA`     | `"process-ledger.v1"`        | `schema` stored on every history row.                              |
| `LIVE_SCHEMA`       | `"process-ledger.live.v1"`   | `schema` stored on the live snapshot.                              |
| `DEFAULT_MAX_BYTES` | `8388608`                    | History cap when `options.maxBytes` is omitted. `8 * 1024 * 1024`. |
| `MAX_ROLE_LENGTH`   | `80`                         | Maximum characters kept from `role`.                               |
| `MAX_ACTION_LENGTH` | `40`                         | Maximum characters kept from `action`.                             |
| `MAX_SOURCE_LENGTH` | `160`                        | Maximum characters kept from `source`.                             |
| `MIN_PID`           | `2`                          | Smallest pid `register` will record. `0` and `1` return `false`.   |
| `DEFAULT_ACTION`    | `"start"`                    | `action` used when the caller omits it or passes a falsy value.    |
| `LIVE_CORRUPT_CODE` | `"LIVE_CORRUPT"`             | `code` on `LedgerReadError`.                                       |
| `HISTORY_FILE_NAME` | `"process-ledger.jsonl"`     | History file name inside `root`.                                   |
| `LIVE_FILE_NAME`    | `"process-ledger-live.json"` | Live snapshot file name inside `root`.                             |

### `LedgerReadError`

Thrown when the live file exists and cannot be used as a snapshot. `name` is `"LedgerReadError"`. `code` is `LIVE_CORRUPT_CODE`. `cause` is the `SyntaxError` from `JSON.parse` when the file is not valid JSON, and `undefined` otherwise.

A missing live file does not throw. Any other filesystem error, such as `EACCES` or `EISDIR`, is rethrown unchanged and is not a `LedgerReadError`.

### `createLedger(root, options)`

Open one ledger rooted at a directory. The directory is created on the first successful `register`, not when the ledger is constructed, and not when a `register` call returns `false`.

| Argument  | Type             | Role                                                                      |
| --------- | ---------------- | ------------------------------------------------------------------------- |
| `root`    | string           | Directory for the history file and the live snapshot.                     |
| `options` | object, optional | `{ maxBytes }`. Omitted, `null`, and `undefined` use `DEFAULT_MAX_BYTES`. |

`root` must be a string. Any other type throws `TypeError`. An empty string is a string, and the files are then resolved against the current working directory.

`options`, when present, must be a non-array object. `maxBytes`, when present, must be a finite number greater than `0`. `0`, a negative number, `NaN`, and `Infinity` throw `TypeError`. A positive fraction is accepted. The usual value is a positive integer.

The return value is `{ register, live, livePids }`.

### `register(input)`

Record one start, or one other action, for one role. Returns `true` when the row was written. Returns `false` when the row was refused. A refusal writes nothing: no directory, no history line, and no live snapshot.

| Field    | Type             | Role                                                                                       |
| -------- | ---------------- | ------------------------------------------------------------------------------------------ |
| `role`   | string           | Role name. Cut to `MAX_ROLE_LENGTH` characters.                                            |
| `pid`    | number           | Process id. Must be an integer greater than or equal to `MIN_PID`.                         |
| `action` | string, optional | What happened. Cut to `MAX_ACTION_LENGTH`. A missing or falsy action is `DEFAULT_ACTION`.  |
| `source` | string, optional | Caller label for the start. Cut to `MAX_SOURCE_LENGTH`. A missing or falsy source is `""`. |
| `at`     | string, optional | Timestamp stored as given. A missing or falsy `at` is `new Date().toISOString()`.          |

`input` must be a non-array object. `null` and `undefined` throw `TypeError`. The checks that return `false` run in this order:

1. `role` is falsy, so the stored role would be `""`. A missing role, `null`, `undefined`, and `""` all return `false`. A role of spaces is not empty and is stored. A longer role is cut to 80 characters and then accepted.
2. `pid` is not an integer, or the integer is below `2`. `Number` is applied first, so the string `"4100"` is accepted and `2.5` is refused. `0`, `1`, negatives, `NaN`, and fractions return `false`.

`false` is the whole refusal. There is no error object for a bad role or a bad pid.

A successful call does four things, in order:

1. Read the live snapshot. A corrupt snapshot throws `LedgerReadError` here, before the history grows.
2. Append one JSON line to the history file. The line is `{"schema","at","role","pid","action","source"}` with `schema` set to `LEDGER_SCHEMA`.
3. Trim the history when its size is above `maxBytes`. A trim failure throws. The new history line is already on disk, and the live snapshot is left as it was.
4. Replace that role in the snapshot and write the snapshot. Other roles already in the snapshot stay. `schema` becomes `LIVE_SCHEMA` and `at` becomes the new row's `at`.

The live role value is `{ pid, at, action, source }`.

A falsy `role`, `action`, or `source` uses the fallback above. A truthy non-string is passed through `String` and then cut. The number `0` is falsy, so it becomes the fallback rather than `"0"`.

### `live()`

Return the live snapshot.

A missing file returns a new object each call:

```js
{ schema: "process-ledger.live.v1", at: "", roles: {} }
```

A present file is parsed after a leading byte-order mark is removed. The parse is accepted when the value is a non-array object and `roles` is a non-array object. Extra fields are kept. A snapshot that is only `{"roles":{}}` is an empty ledger that exists on disk, and it does not throw.

These files throw `LedgerReadError`:

- empty, or only whitespace
- not valid JSON
- JSON that is not an object, including an array or `null`
- an object whose `roles` field is missing, `null`, or an array

`live` does not create the directory and does not create the file.

### `livePids()`

Return the live pids. The order is the insertion order of `roles`. Pids are not sorted and are not deduplicated. A role whose value is not an object, or whose `pid` is not an integer greater than or equal to `MIN_PID`, is skipped.

A missing live file returns `[]`. A corrupt live file throws the same `LedgerReadError` as `live()`.

### `planRoleRecovery(role, entries, alive)`

Choose which living pid to keep for one role, which living duplicates to stop, and whether a new process should be started.

This function does not return `false`. An empty role does not refuse the plan. Refusal of an empty role, and of a pid below 2, belongs to `register`.

| Argument  | Type     | Role                                                                                 |
| --------- | -------- | ------------------------------------------------------------------------------------ |
| `role`    | string   | The role this plan is for. Entries that carry their own `role` string must match it. |
| `entries` | array    | Candidates. Each entry is `{ pid, startedAt, listening }` and may also carry `role`. |
| `alive`   | function | `(pid) => boolean`. `true` means that pid is still running.                          |

`entries` must be an array. `alive` must be a function. Anything else throws `TypeError`.

`role` is read. It is not ignored.

- An entry with a string `role` is used only when that string is strictly equal to `role`.
- An entry that omits `role`, or whose `role` is not a string, stays in the plan. Existing callers that pass `{ pid, startedAt, listening }` are ranked exactly as before.
- A `role` argument that is not a string is treated as `""` for that comparison. Entries that omit `role` are still ranked.

The plan uses only the entries that belong to the role and for which `alive(pid)` is `true`. Dead entries are not killed. They are already gone.

When no living entry remains, the return value is `{ keep: null, kill: [], start: true }`. Start one process. Do not signal the dead pids.

When at least one entry is alive, the return value is `{ keep, kill, start: false }`. `keep` is a pid. `kill` is the other living pids, in the same order as the ranking after `keep`.

The ranking, among the living entries:

1. A listening entry beats a non-listening entry. `listening` is read with `Boolean`, so only a falsy value loses.
2. Otherwise the earlier `startedAt` wins. Both sides are compared as strings with `localeCompare`.

The winner is `keep`. Every later living pid is listed in `kill`. `start` is `false`, because a living process is already there.

The input array is not mutated. `listening` and `startedAt` are not required to be present. A missing `listening` is not listening. A missing `startedAt` is compared as the string `"undefined"`.

### `planStormRecovery(roles, caps, alive)`

Stop the oldest living processes above a per-role cap. One map may hold several roles. Each role is capped on its own.

| Argument | Type     | Role                                                                |
| -------- | -------- | ------------------------------------------------------------------- |
| `roles`  | object   | Map of role name to an array of `{ pid, startedAt }`.               |
| `caps`   | object   | Map of role name to the number of living processes that may remain. |
| `alive`  | function | `(pid) => boolean`, same meaning as in `planRoleRecovery`.          |

`roles` and `caps` must be non-array objects. `alive` must be a function. Anything else throws `TypeError`.

The roles that are policed are `Object.keys(caps)`, in that order. A role present only in `roles` is not touched. A cap whose role is missing from `roles`, or whose value is `null` or `undefined`, contributes no kills. Any other group value is treated as the entry list and must be an array.

For each policed role:

1. Keep the entries for which `alive(pid)` is `true`.
2. Sort those entries by `startedAt` ascending, as strings, without mutating the input array.
3. Let `overflow` be `max(0, livingCount - cap)`.
4. The first `overflow` entries in that oldest-first order are kills.

Each kill is `{ role, pid }`. The return value is those kills in role order, and within a role from oldest to newer. A cap of `0` kills every living entry of that role. A cap larger than the living set kills nothing. A non-numeric cap produces no kills for that role, because the overflow is not a positive number.

Dead entries are not returned. Stopping them is not required.

## Design notes

The ledger separates a record from a decision. `register` remembers that a pid was started. `planRoleRecovery` and `planStormRecovery` do not open the ledger, and they do not stop a process. A supervisor can plan from a process table it collected itself, then apply the plan with its own signals.

One role has one live row. A new `register` for that role replaces the row and leaves the previous line in the history. The history is how a later reader sees the duplicate. The snapshot is how a reader sees the current claim.

Pid `1` is not a service pid. On a Unix system it is the init process. Pid `0` is not a userspace process id either. `register` therefore returns `false` for every integer below `MIN_PID`, and it returns `false` for an empty role, so a blank name cannot occupy the snapshot. The planners do not repeat that check. They rank the entries the caller already collected.

The listener wins because a pid file can outlive a failed bind. A newer process that is not listening is the duplicate, even when its `startedAt` is later. If none of the pids are alive, the plan starts one process and does not list the dead pids in `kill`. Killing a corpse is not part of the start.

Storm recovery is for a class of helpers that may run more than once. The cap is per role, inside one map, so a shell storm and a worker storm are trimmed independently. The oldest `startedAt` stops first. Roles that the caller did not put in `caps` are someone else's business.

The history cap is `DEFAULT_MAX_BYTES` unless the caller passes `maxBytes`. Trim walks backward from the newest line and keeps a suffix of whole JSON lines. It does not cut a line in half. The newest line is kept even when that single line is larger than the cap, so a trim never leaves an empty file in place of a line that was just appended. Older lines are added only while they still fit. Blank lines are dropped. A failure from `stat`, `read`, or `write` is thrown. It is not turned into a successful trim and it is not turned into an empty ledger.

The live snapshot is written by creating a new temporary file and renaming it onto `process-ledger-live.json`. The temporary name contains the process id and a per-ledger sequence. It is not the shared path `process-ledger-live.json.next`. Two registers, including two processes, therefore do not truncate one another's temp file. Rename on the same directory replaces the snapshot. The library does not take an inter-process lock. Two registers that read the snapshot, then both write, are still last-writer-wins for the JSON object. A crash after the temp file is created and before the rename can leave a `process-ledger-live.<pid>.<sequence>.json.next` file. That file is not the snapshot.

A missing live file and a corrupt live file are different states. The first run has no file, and `live()` returns an empty snapshot. A file that is present but unreadable as a role map throws `LedgerReadError` from `live`, `livePids`, and `register`. `register` throws before it appends, so a corrupt snapshot is not overwritten by the next start and the history does not gain a row the snapshot never accepted. Callers that want to replace a damaged file delete it themselves and then register again.

This module does not inspect the process table, signal a pid, or schedule a restart. It does not read environment variables. Names of hosts, addresses, and service accounts stay with the caller. `role` is an opaque string. `source` is an opaque string. Neither is interpreted.

## Compatibility

Version 1.1.0 keeps `createLedger`, `register`, `live`, `livePids`, `planRoleRecovery`, and `planStormRecovery`, the argument order, the `false` return from `register`, and the plan shape `{ keep, kill, start }`. History rows and live role objects keep the same fields. The on-disk file names are unchanged.

`register` still returns `false` for an empty role and for a pid below 2, including pid `0` and pid `1`, and it still writes nothing in that case.

These behaviors changed because version 1.0.0 hid failures:

- A live file that exists but is empty, not JSON, or has no `roles` object throws `LedgerReadError`. Version 1.0.0 returned `{ schema, at: "", roles: {} }`, so a corrupt snapshot looked like a ledger that had never been written.
- `register` reads the snapshot before it appends. A corrupt snapshot throws, and the history file is not extended. Version 1.0.0 replaced the corrupt snapshot on the next successful register.
- `trim` no longer catches errors. A filesystem error during trim propagates. Version 1.0.0 used an empty `catch`, so a failed trim looked like a ledger that did not need trimming, and `register` still returned `true`.
- The temporary file for the atomic rename is unique per write. Version 1.0.0 always used `<root>/process-ledger-live.json.next`, so two concurrent registers could race on that one path.
- `planRoleRecovery` reads `role`. An entry whose own `role` is a string is ranked only when it equals that argument. Entries that omit `role` are ranked as in version 1.0.0. The return value does not gain a field.
- An explicit `maxBytes` of `0`, a negative number, `NaN`, or `Infinity` throws `TypeError`. Version 1.0.0 treated a falsy cap as the default and accepted a negative cap. Omitting `maxBytes` still selects `DEFAULT_MAX_BYTES`.

`LedgerReadError`, `LIVE_CORRUPT_CODE`, `DEFAULT_MAX_BYTES`, `MAX_ROLE_LENGTH`, `MAX_ACTION_LENGTH`, `MAX_SOURCE_LENGTH`, `MIN_PID`, `DEFAULT_ACTION`, `HISTORY_FILE_NAME`, and `LIVE_FILE_NAME` are new exports.

## License

Released under the MIT License. The full text is in [LICENSE](LICENSE).
