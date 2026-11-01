# Apple device native bridge

The desktop process loads this N-API 8 addon and exposes it through the authenticated
Apple device bridge. It uses EventKit directly for Calendar and Reminders. No
Contacts API or AppleScript is included. macOS 13 uses legacy EventKit access;
macOS 14 and later request full access with the current per-resource APIs.

Build from the repository root:

```sh
node scripts/build-apple-device-native.cjs
node scripts/build-apple-device-native.cjs --check
node --test scripts/apple-device-native-unit.cjs scripts/apple-device-package-unit.cjs
```

The default build is universal (arm64 and x86_64); `--arch=arm64` and `--arch=x64`
are available. The builder reads local Node N-API headers, including an explicit
`SHOGGOTH_NODE_HEADERS` directory if set. It writes `.vendor/apple-device/` with
`apple-device.node` and a source/build/header/output hash manifest. Package both
files into the app's `Resources/apple-device/` directory before signing.

`packagedAppleDeviceManifest(appPath, false, {arch})` from
`scripts/apple-device-package.cjs` checks source/build identity, native content
hash, physical files and actual architecture slices before signing. After all
nested native signing and before the outer app signature, call the same helper
with `true` as its second argument to seal the new binary hash. The CLI
form is `node scripts/apple-device-package.cjs --app /absolute/Test.app` with
optional `--update` and `--arch=arm64|x64|universal`.

`invoke(JSON.stringify({operation, params, requestId?}))` returns a Promise of a JSON envelope:
`{ok:true,result}` or `{ok:false,error:{code,message}}`. The JavaScript wrapper
returns `result` and converts native failures into safe errors with the same code.
The desktop wrapper accepts `invoke(operation, params, {signal})`, creates its
own random internal request id, and calls the addon's `cancel(requestId)` when
the authenticated invocation is aborted. Request ids are transport bookkeeping,
never agent-supplied approval tokens.
Only `requestAccess` can present privacy permission UI. `status` is non-prompting;
all record operations require existing full system access.

Supported operations are `status`, `requestAccess`, `calendar.list`,
`calendar.events`, `calendar.get`, `calendar.create`, `calendar.update`,
`calendar.delete`, `reminders.lists`, `reminders.search`, `reminders.get`,
`reminders.create`, `reminders.update`, and `reminders.delete`. The service owns
application/assistant policy and binds every write to an approved argument set.

Updates and deletes require the latest 64-character `expectedRevision`. Revisions
hash the current fields, recurrence rules and last modification date. Event ids
are opaque and include occurrence identity because EventKit's raw event lookup
returns the first occurrence. Calendar writes additionally require explicit
`scope: "this" | "future"`. Treat every returned id as opaque and forward it intact.

Query outputs are limited to 100 items and less than 48 KiB. Smaller result sets
return `truncated:true` when either requested item count or response size is
exceeded. Calendar/list filters accept 0–32 identifiers; an explicit empty array
returns an empty result. Event queries span at
most 366 days. Reminder fetches use Apple's asynchronous API with a 30-second
timeout; EventKit fetches all matching reminders internally before output is
bounded. External records' title/notes/location fields are clipped at UTF-8
character boundaries to the service DTO limits, while revision hashes include
the complete source values.

Status resolves through non-prompting authorization class APIs without entering
the serialized store queue or libuv's worker pool. It remains responsive while
an explicit authorization request waits for user input (up to 30 minutes).
All other native operations share one admission slot and reject concurrent calls
with `APPLE_DEVICE_BUSY`. Cancellation retains that slot until the actual work
acknowledges cancellation. A monotonic deadline starts at native admission (30
seconds for data operations, 30 minutes for authorization), and cancellation and
deadline checks run before store access and each save/delete. Authorization waits
poll every 50 ms; a separate permission store survives a late system callback.
`node scripts/apple-device-native-deadline-smoke.cjs` is an explicit ~31-second
low-CPU check that a job delayed behind a blocked libuv worker expires before
entering an operation. It only uses an invalid operation and never accesses data.

Automated acceptance uses `status`, invalid requests, and permission rejection
only when status already confirms no full authorization. The packaging fixture
scans a tiny isolated resource-only app for private keys, signs its addon ad hoc,
refreshes its manifest, loads status, and checks tamper rejection. Actual system
prompts, permission attribution, denial/revocation, and CRUD behavior must be
accepted with a signed packaged app and dedicated test calendar/list data.
