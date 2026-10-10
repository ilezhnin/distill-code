# Z.ai Coding Plan

Distill runs GLM models through OpenCode's native ACP interface. In Settings >
Providers, install the Z.ai Coding Plan runtime, choose Add account, and paste
a key from the [Z.ai API console](https://z.ai/manage-apikey/apikey-list).
An active GLM Coding Plan is required. A login at chat.z.ai alone does not
provide this subscription.

The account uses `https://api.z.ai/api/coding/paas/v4`, the subscription endpoint
documented in [Z.ai's OpenCode guide](https://docs.z.ai/devpack/tool/opencode).
Only the `zai-coding-plan` provider is enabled. There is no automatic fallback
to the separately billed general API. Model availability still depends on the
account's plan. The model and effort pickers use OpenCode's live ACP inventory.
The newest GLM generation appears first; earlier generations are in More models.
When the inventory offers both a model and its Highspeed variant, Fast mode
selects between them. Flash remains a separate model. Effort uses the composer’s
separate control and is retained when changing speed if the variant supports it.

Keys use the same Windows DPAPI storage as other managed Distill accounts.
The model runtime receives only its account's key; usage checks send it only to
Z.ai's quota endpoint. OpenCode's config, data, cache
and state directories are private to each account. Its own project configuration
is disabled for this integration so it cannot change the selected provider or
endpoint. Distill still supplies the chat's project context through its normal
session flow. Automatic conversation sharing is disabled.

Auto mode allows tools, approval mode asks for tools, smart approval allows file
reads and edits while asking for other tools, and chat mode uses OpenCode's plan
agent. Sign out clears the saved key while retaining account identity and chats.

The card identifies the connection as GLM Coding Plan. Saving a key does not
purchase a subscription. Distill reads account quota from Z.ai's
`/api/monitor/usage/quota/limit` endpoint with the saved key, following the
[official usage plugin](https://docs.z.ai/devpack/extension/usage-query-plugin).
The account card and Usage menu show five-hour and weekly consumption and
reported reset times. Account details also show credit balances and any reported
MCP tool-call allowance. Missing values remain unknown. A failed refresh preserves
previous measurements with an error; a telemetry cooldown is not an exhausted
model allowance. The integration never redeems quota resets automatically.
Z.ai sessions are not admitted to native benchmark profiles until that runtime
is verified there.
