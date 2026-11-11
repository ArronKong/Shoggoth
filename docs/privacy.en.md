# Shoggoth product statistics privacy notice

Updated November 11, 2026.

In desktop releases with product statistics active, **Usage statistics** and **Share feature usage** are on by default. You can change either at any time under **Settings → Privacy and statistics**. Turning off Usage statistics stops both levels and clears unsent data. Turning off Share feature usage keeps only basic activity statistics. Upgrades preserve your choice to turn either off.

Maintainers use these statistics to understand active installations, version distribution, feature adoption, and operation quality. We count activity by UTC date and random installation ID. Each app data directory has one random ID, and a day counts when you first interact with the foreground window.

## What we collect

| Scope | Data |
| --- | --- |
| Basic activity | Random installation ID, random event ID, UTC time and date, app version, operating system family, CPU architecture, and data format and policy versions. |
| Feature usage | Page categories you use and daily counts of attempts, successes, failures, and cancellations for direct chat, group chat, Inspiration, tasks, scheduled tasks, models, skills, assistants, and connectors. Group chat success means your message was submitted. Task and scheduled task results reflect the outcome the app can verify for the request. |
| Operation quality | Fixed error categories (network, timeout, authentication required, permission, unsupported, validation, and unknown) and duration ranges (under 1 second, 1–5 seconds, 5–30 seconds, 30–120 seconds, and 120 seconds or more). |
| Configuration and adoption | Configured backends, assistant runtimes, providers, and models, plus runtimes, providers, and models confirmed by chat execution. We record enabled public connectors and their categories, skill counts and source categories, and counts of assistants and configured items. Configuration comes from views the app reads successfully. Missing categories are marked as unobserved and unconfirmed execution metadata as unknown. |
| Setup progress | Starting setup, successful verification after a user initiates a connection, and the first successful direct chat. Each step is recorded at most once per app data directory. |

The app aggregates detailed statistics locally by UTC day. Public provider, model, and connector names come from a list shipped with the app. Custom entries use fixed categories. Summaries include the public catalog version and, where applicable, coverage, truncation, or count limit flags.

Statistics exclude messages, prompts, replies, tool content, chat and task text, Inspiration notes, assistant instructions, search or input content, file names and paths, URLs, credentials, usernames, email addresses, account and session identifiers, exact token usage, costs, logs, screenshots, recordings, hardware fingerprints, and hashes of these values.

## Sending and retention

The app attempts to send basic activity and setup steps after recording them. Detailed summaries are prepared after the end of a UTC day and may wait until the next launch. The app keeps unsent statistics for up to seven days. Turning off a level cancels its in-flight requests and clears its unsent data. Turning it back on starts with new actions and current configuration. The app retains the local installation ID and a small set of markers to prevent duplicate counts.

Releases with export enabled send statistics over HTTPS to PostHog Cloud in the United States (`us.i.posthog.com`). The project discards client IP data, and the app disables GeoIP enrichment and person profiles. The recipient can see the connection's source IP at the network layer. The random ID can link activity across days from the same installation. The project's current free plan retains product analytics events for one year. [PostHog Product Analytics plans](https://posthog.com/product-analytics/pricing)

Turning off statistics cannot recall data the recipient already received. For privacy questions or deletion requests, ask the maintainer for a follow-up contact channel through [GitHub Issues](https://github.com/ArronKong/Shoggoth/issues). Keep identities, credentials, and installation identifiers out of public posts.

These controls cover Shoggoth product statistics. Model providers, external connectors, and runtimes you use handle requests according to their own settings and terms.
