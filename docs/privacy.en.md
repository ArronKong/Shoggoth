# Shoggoth product statistics privacy notice

Updated November 26, 2026. Applies to statistics schema v3.

In official desktop releases with statistics enabled, **Settings → Privacy and statistics → Share usage data** is on by default. Turning it off stops product statistics and clears unsent data. Upgrades preserve your previous choice, including activity-only sharing. Setting `DO_NOT_TRACK=1` or `SHOGGOTH_TELEMETRY_DISABLED=1` in the desktop app's launch environment also disables statistics.

Maintainers use these statistics to understand active installations, version distribution, feature adoption, and operation quality. Each app data directory has a random installation ID. Opening the main window or bringing it back to the foreground counts, even if you close it immediately. If it stays open overnight, your first foreground interaction can count the next day. Each installation counts at most once per UTC day. Background services alone do not count. Schema v2 and earlier required a foreground interaction.

## What we collect

| Scope | Data |
| --- | --- |
| Basic activity | Random installation ID, random event ID, UTC time and date, app version, operating system family, CPU architecture, and data format and policy versions. |
| Feature usage | Page categories you use and daily counts of attempts, successes, failures, and cancellations for direct chat, group chat, Inspiration, tasks, scheduled tasks, models, skills, assistants, and connectors. Group chat success means your message was submitted. Task and scheduled task results reflect the outcome the app can verify for the request. |
| Operation quality | Fixed error categories (network, timeout, authentication required, permission, unsupported, validation, and unknown) and duration ranges (under 1 second, 1–5 seconds, 5–30 seconds, 30–120 seconds, and 120 seconds or more). |
| Direct chat, connector authorization, and background tasks | Daily counts for each of the seven error categories are grouped separately for chat sends and connector authorization. Opening the details of a completed background task sets a flag for that day. |
| Configuration and adoption | Configured backends, assistant runtimes, providers, and models, plus runtimes, providers, and models confirmed by chat execution. We record enabled public connectors and their categories, skill counts and source categories, and counts of assistants and configured items. Configuration comes from views the app reads successfully. Missing categories are marked as unobserved and unconfirmed execution metadata as unknown. |
| Setup progress | Starting setup, successful verification after a user initiates a connection, and the first successful direct chat. Each step is recorded at most once per app data directory. |

The app aggregates detailed statistics locally by UTC day. Public provider, model, and connector names come from a list shipped with the app. Custom entries use fixed categories. Summaries include the public catalog version and, where applicable, coverage, truncation, or count limit flags.

**Illustrative example.** Opening the app three times, completing two direct chats, and opening a completed task on the same day produces one active installation day. The feature summary includes `chat_send_success_count: 2` and `opened_completed_background_task: true`. [Event fields](../app/core/product-telemetry-schema.js) · [Public feature and model catalog](../app/core/data/product-telemetry-catalog.json)

Statistics exclude messages, prompts, replies, tool content, chat and task text, Inspiration notes, assistant instructions, search or input content, file names and paths, URLs, credentials, usernames, email addresses, account and session identifiers, exact token usage, costs, logs, screenshots, recordings, hardware fingerprints, and hashes of these values.

## Sending and retention

The app attempts to send basic activity and setup steps after recording them. Detailed summaries are prepared after the end of a UTC day and may wait until the next launch. Offline events are eligible for retry for seven days. Records that expire while the app is closed are cleared on a subsequent run. Turning off sharing cancels in-flight requests and clears unsent data. Turning it back on starts with future opens and actions. The app retains the local installation ID and a small set of markers to prevent duplicate counts.

Official releases send statistics over HTTPS to PostHog Cloud in the United States (`us.i.posthog.com`). The project discards client IP data, and the app disables GeoIP enrichment and person profiles. The recipient can see the connection's source IP at the network layer. The random ID can link activity across days from the same installation. The project's event retention setting is one year. PostHog cleans up expired events in monthly batches, which can add up to about two months. Deleted data typically remains in backups for about two more weeks. [PostHog data storage](https://posthog.com/docs/privacy/data-storage)

Turning off statistics cannot recall data the recipient already received. For privacy questions or deletion requests, ask the maintainer for a follow-up contact channel through [GitHub Issues](https://github.com/ArronKong/Shoggoth/issues). Keep identities, credentials, and installation identifiers out of public posts.

These controls cover Shoggoth product statistics. Model providers, external connectors, and runtimes you use handle requests according to their own settings and terms.

## Creating a local diagnostic file

Under **App diagnostics**, select **Create diagnostic file** and choose where to save it. Canceling the dialog ends the export. The local file contains the app version, operating system family, and a summary of recorded failures. Each fixed error code has a last-seen time in UTC, an occurrence count, and the stage where it occurred. If the same code appears at several stages, each stage has its own count and last-seen time.

Counts cover recent failures retained on this device, up to eight startup records and eight background service records. A code repeated within one failure counts once. Older records show the process and stage available at the time, such as MCP helper startup. You can create the file with usage sharing turned off and decide whether to send it to support.
