# Provider accounts

Settings > Providers shows one combined setup and account group for each of
Claude Code and Codex. Their install/update controls live in that group; the
remaining providers are listed once under Other providers. Add each
subscription account in Distill and complete its initial browser authorization once. API accounts
accept a separate key. Switching uses that account's saved credentials; it does
not sign out another account. The provider CLI refreshes OAuth credentials.
Revoked authorization still requires a new sign-in.

Each connected profile offers Sign out. Subscription accounts use the
official logout command in that account's private home; API accounts clear only
their saved credentials. Sign-out keeps account IDs, defaults, and chat history,
then shows Sign in on the same profile. Busy accounts reject credential changes.
Signing back into an API account requires a new key. Account cards do not offer
editing or removal, and the reported identity is shown only once.

Set a provider default for new chats, or use the account selector in an existing
chat. Existing chats without an account ask the user to choose a connected
account before continuing. Concurrent chats can
use different accounts. A switch preserves the Distill transcript and selected
model; native CLI session state does not move between accounts. Switching a busy
chat is rejected until its current turn ends.

## Limits and automatic switching

The account panel polls every minute and refreshes on window focus or request.
It shows reported subscription, quota windows, reset times, account identity,
reset-credit inventory, and freshness. Missing provider telemetry is displayed
as unknown, never as an unlimited allowance. API-key accounts do not expose a
subscription quota meter. Claude's pinned CLI does not expose a reset-credit
inventory or redemption contract, so those fields remain unknown for Claude.

Account cards, the account picker, and status details share the same usage
projection and quota row component. Reported durations identify the five-hour,
weekly, and monthly windows; provider field names are not display labels.
Only reported windows appear. The status bar selects the provider's default
account from the account monitor, without fetching a separate quota snapshot.

Automatic switching is controlled by one compact switch in each provider's
header. It applies to all saved accounts in that group; individual accounts have
no enable or inclusion switches. Legacy account-level opt-outs are cleared when
the account index is read, while each provider's saved switch stays unchanged.
The current account remains selected while usable. A quota failure can select
another available account for the same provider and billing mode; a subscription
chat does not automatically become a paid API chat. An API chat can switch to
another API account in its provider group.

When every eligible account is exhausted, the message stays queued. Distill
waits for the earliest time at which an account's blocking windows have all
reset. Unknown reset times are polled again. A manual account change or fresh
available quota wakes the queue. A partially executed turn is never replayed
automatically; transparent retry requires proof that the provider accepted no
prompt activity and the host removed its rejected turn.

**Reset credits are operator-only.** Polling, routing and queued retries never
consume them. The operator selects Use reset and confirms the specific account.
The Codex operation carries an idempotency UUID; an uncertain retry in that
dialog reuses the UUID to prevent duplicate redemption.

## Storage and protocol

`<DISTILL_ROOT>/provider-accounts/index.json` stores account IDs, labels, provider
defaults and routing preferences. Each managed UUID has a separate home in this
directory. The provider runtime installed by Distill owns its OAuth token lifecycle. Windows account
directories are restricted to the current user and SYSTEM; API keys use Windows
DPAPI. Credentials are not returned to renderer stores or included in chat
metadata. Keep this directory private when copying or backing up a data root.

Host sessions persist `account_id` in SQLite. Processes, event routing, model
inventories and native session IDs are scoped to the provider and account.
Inherited credentials from a different account are removed for managed entries.
Updating credentials or removing an account is blocked while it runs a turn.

There is no system CLI account or fallback to credentials from another app.
Both providers use the same account flow and isolated storage. The v2 account
index drops the old external-login entries while retaining saved Distill
accounts, their credentials and routing preferences. The database migration
clears external account references without changing transcripts. Selecting a
connected account resumes these chats through transcript transfer. Importing
native CLI session state and any authorization needed for that import are
separate from connecting a Distill account.

Codex status and manual reset use its native app-server account APIs. Claude
status uses the pinned CLI's `initialize` and `get_usage` control requests with
hooks, tools, MCP and session persistence disabled. Neither telemetry adapter
sends prompts or starts model inference. The CLI determines effective billing
and refreshes expired OAuth credentials, including accounts idle between uses.
