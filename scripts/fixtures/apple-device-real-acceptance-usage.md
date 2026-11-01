# Real App acceptance core (prepared, not executed)

`apple-device-real-acceptance-core.cjs` exports `createScopeGuard(scope)` and
`run(options)`. Importing the module does not launch an App or access Apple data.
Run only after the user has installed the candidate App and explicitly said to
begin real acceptance. Use the **same App instance, Service and approval UI**.

Before running, the user/root supplies two fresh dedicated, writable containers:
an Apple Calendar ID and a Reminders list ID, plus a cryptographically random
32-character lowercase hexadecimal token. Discovering those IDs is a separate
reviewed preparation step; the core deliberately forbids listing all containers.
Connect both applications in the real App first. The core only checks system
authorization and refuses to request TCC permission itself.

Required callbacks:

- `getStatus()` returns the current real Service Apple connector status,
  including each resource's independent `readPolicy` and `writePolicy`.
- `setPolicy(resource, patch)` merges the patch into that resource's latest
  policy, preserves its other reading/writing choice and assistant blocks, performs the normal CAS save,
  and returns the full resulting status (including `revision` and `resources`).
- `invoke(name, arguments, {callId, signal})` invokes the actual controller or
  trusted MCP tool path in this App with a dedicated native Profile/Session/Run.
  Pass the provided call ID and AbortSignal through; return the raw tool DTO or
  throw the original public error. Do not replace `requestApproval`.
- `review({expected, pending, signal, verify})` waits for the **real** Coordinator
  pending approval for this Run, calls `verify(record)` on its complete record,
  then arranges the exact `once` response through the real App UI/approval API.
  The callback may pause for a human click. It must not synthesize an approval
  result, select `always`, or skip the `verify` call. `expected` contains the
  exact tool arguments and call ID. Supply `owner:{runId, profileId}` to `run`
  to bind the expected owner; the Coordinator record always carries `runId`.
- `report(entry, ownedIds)` persists an incremental, private acceptance journal
  outside product data. It receives only scope/step/receipt metadata, not record
  notes or other content. Persist each call so interrupted cleanup can target
  the exact recorded IDs.

Example skeleton (all instance binding is supplied by the real App driver):

```js
const { createScopeGuard, run } = require('./apple-device-real-acceptance-core.cjs');
const guard = createScopeGuard({ calendarId, listId, token });
const result = await run({ guard, invoke, getStatus, setPolicy, review, report,
  owner: { runId, profileId }, signal: acceptanceAbort.signal });
```

For an additional native boundary check, the App driver can call
`guard.checkNative(operation, params)` before forwarding each acceptance native
invocation. Status is allowed; `requestAccess`, settings changes, unfiltered
queries, default-container creation, foreign IDs, container moves and recurring
future mutations are rejected. The core applies the same guard before every
product tool call. Its owned-ID set is populated only by successful creation
receipts. Internal update/delete target reads are restricted to those IDs.

The cycle for each resource verifies allowed reading, two separately approved
reads, denied reading, then separately approved creation/update/deletion while
reading is off and `writePolicy` is explicitly `ask`. It temporarily allows only explicitly filtered reads to verify
the changes and final cleanup. There are 10 expected real approval requests:
4 reads and 6 writes. Calendar events are one-hour, non-recurring records two
days in the future; reminders have no due date. Every created title and notes
begins with the unique acceptance marker. Unrelated rows or truncated responses
stop the cycle without printing their content.

The core deletes its two known records on success, then restores the original
connector policies, including the original writing choice. The independent
Allow/Off writing and writing-revocation cases in the acceptance plan run as
separate dedicated-object checks; this basic cycle does not claim to cover them.
Restoration refuses to overwrite any intervening policy
revision from the UI or another task. On failure/cancellation it aborts pending
work, reports exact owned IDs and stops; it **does not automatically retry a
write or delete leftover records**. Review the journal and use separately
approved cleanup, limited to the dedicated containers and this token.

Prepared verification only:

```sh
node --check scripts/fixtures/apple-device-real-acceptance-core.cjs
node scripts/apple-device-real-acceptance-core-unit.cjs
```

These commands perform syntax/pure scope-guard checks and access no Apple data.
They do not establish real App/TCC/CRUD acceptance.
