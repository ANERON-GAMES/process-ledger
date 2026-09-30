# process-ledger

One live process per role, with an append-only history of every start.

A supervisor that only checks "is HTTP 200" will leave a hung copy running and then start a second copy. A supervisor that only checks a pid file will trust a process that failed to bind its port. This ledger records the start, then answers a separate question: which pid to keep, which duplicates to stop, and whether a start is still allowed.

```js
import { createLedger, planRoleRecovery } from "./src/index.js";

const ledger = createLedger("./state");
ledger.register({ role: "gateway", pid: process.pid, action: "start" });

const plan = planRoleRecovery("gateway", [
  { pid: 4100, startedAt: "2026-09-15T11:26:00.000Z", listening: true },
  { pid: 4188, startedAt: "2026-09-23T14:51:00.000Z", listening: false }
], (pid) => pid === 4100 || pid === 4188);

// plan.keep === 4100, plan.kill === [4188], plan.start === false
```

The listener wins over a newer process that never bound the port. If every recorded pid is dead, the plan starts exactly one. `planStormRecovery` applies a cap to a class of helper processes and stops the oldest overflow.

The live snapshot is written through a temporary file and a rename. The history file is trimmed on a JSON line boundary when it passes the byte cap.

```
node --test
```

MIT. Vadim Gubin.
