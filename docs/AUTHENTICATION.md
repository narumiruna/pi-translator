# Authentication and Providers

Vibe Translator uses `@earendil-works/pi-ai` for provider catalogs, model metadata, authentication, and text completion. The background service worker owns the runtime; options, content scripts, and web pages never receive credentials.

## Supported provider boundary

The browser build registers all 40 browser-compatible built-in `pi-ai` providers and their text/chat models, plus **Custom OpenAI-compatible**. The bundled catalog currently contains more than 1,200 models and follows the installed `pi-ai` version.

- Every listed provider except OpenAI Codex exposes its browser-safe `pi-ai` API-key flow.
- Anthropic, GitHub Copilot, Kimi For Coding, OpenAI Codex, OpenRouter, Radius, and xAI also expose account OAuth.
- **OpenAI Codex** supports ChatGPT Plus/Pro account sign-in instead of an API-key flow.
- **Meta** exposes API-key authentication only; its account OAuth flow is not implemented in the browser runtime.
- **Radius** loads its model catalog after a Radius API key or account credential is saved.
- **Custom OpenAI-compatible** accepts an API key, a Responses API base URL containing `/v1`, and an exact model ID.
- Models may advertise image input, but Vibe Translator sends text only. Image-generation models are not listed.

Amazon Bedrock is intentionally excluded because its adapter requires the Node-only AWS SDK and credential chain. TypeSafe is excluded because it offers classifier models, not text/chat models. The extension replaces `pi-ai`'s Node callback servers with Manifest V3-safe device-code or manual callback flows and advertises only OAuth implementations that can run in the background service worker.

## Configure an API-key provider

1. Open **Extension options → Setup**.
2. Search for and select a provider and one of its models.
3. Choose **Configure authentication** or **Change authentication**.
4. At **Select authentication method**, choose **Sign in with an API key**. Providers with only one method continue directly.
5. Complete the provider-owned prompts. Providers such as Cloudflare and Azure request the endpoint fields required by their APIs.
6. Choose **Test Connection** and approve the exact endpoint origin when Chrome asks.
7. Save the settings.

The authentication dialog is the only place a new secret is entered.
Its prompt receives focus, Tab and Shift+Tab stay inside the dialog, and Escape cancels the operation.
Background controls cannot receive focus or pointer input while the dialog is open.
After it closes, focus returns to the authentication control and Options shows status only; it never renders the stored key back into a form.

## Sign in with an account

1. Select a provider and model.
2. Choose **Configure authentication** or **Change authentication**.
3. At **Select authentication method**, choose **Sign in with an account**. Providers with only account auth continue directly.
4. Approve the provider's authentication origins if Chrome asks.
5. Complete the provider flow and return to Options.
6. Choose **Test Connection** and approve the selected model endpoint if it was not already granted.

OpenAI Codex, GitHub Copilot, Kimi For Coding, Radius, and xAI use device authorization: open the displayed sign-in page and enter the one-time code. Anthropic and OpenRouter use PKCE with a manual browser handoff because a Manifest V3 service worker cannot listen on pi's localhost callback server. Complete sign-in, copy the final redirect URL or authorization code from the browser, and paste it into the authentication dialog. The failed localhost landing page is expected for that handoff.

Anthropic uses an independent random OAuth state, separate from the PKCE verifier.
Structured callback URLs, query strings, and `code#state` input must contain the matching state.
A manually copied bare code retains the SDK's local-state fallback; it does not prove that state was returned by the provider.
The token exchange sends separate `state` and `code_verifier` fields.
This follows [RFC 6749 sections 4.1.1 and 4.1.2](https://www.rfc-editor.org/rfc/rfc6749#section-4.1.1) and [RFC 7636 sections 4.2 and 4.6](https://www.rfc-editor.org/rfc/rfc7636#section-4.2).
The bundled SDK's field and manual-input contracts were inspected; synthetic exchanges do not prove live provider acceptance.

**Anthropic release gate:** An authorized account owner must test sign-in, cancellation, and credential refresh with the candidate extension before the changed flow is released.
Use legitimate account access and do not share callback URLs, authorization codes, or tokens in reports.
The expected result is a successful independent-state exchange and refresh, with no credential stored after cancellation.
Live Anthropic acceptance remains unverified until that evidence is recorded.

The background service worker validates and stores the returned credential and refreshes expiring access tokens when needed. OpenRouter mints a long-lived API key instead. **Refresh credential** forces a refresh, and **Remove credential** logs out locally. Revoking an authentication origin from Chrome invalidates the affected stored OAuth credential.

## Credential storage and migration

Credentials are keyed by provider in `chrome.storage.local`.
Background initialization restricts both local credentials and synced settings to `TRUSTED_CONTEXTS` before migration or provider use.
Actions and runtime messages wait for initialization; a storage restriction failure blocks provider work.
Content scripts use session messages instead of direct settings storage access.
This also prevents a compromised content script from changing the credential destination through synced settings.
The authentication port rejects connections from normal web/content contexts.
Catalog, authentication status, endpoint lookup, and connection-test administration require a sender from this extension's own page origin.
A sender extension ID alone does not authorize administration.
Catalog and status messages contain no token or key values.

Ordinary settings remain in `chrome.storage.sync`, but no credential field is written there. On the first startup after upgrading:

- an existing `apiKey` moves to provider-scoped local credential storage;
- `https://api.openai.com/v1` maps to the built-in OpenAI provider;
- another legacy `baseUrl` maps to **Custom OpenAI-compatible**;
- `apiKey` and `baseUrl` are removed from the synced settings record.

Removing a credential does not remove the provider/model selection.
Add a new credential before translating again.

Saving settings validates the complete UTF-8 size of the `settings` key and its serialized JSON value against Chrome sync's 8,192-byte item limit.
An oversized draft is rejected before writing, with its current and permitted sizes shown in Options.
The draft and saved settings remain unchanged after a rejected write.
Existing settings remain usable for translation if an in-memory default-prompt migration exceeds the write quota; shorten the draft before saving it.
No storage schema or credential migration is added by this check.

## Host permissions

The manifest declares broad HTTP/HTTPS access as optional, not automatic. Vibe Translator derives exact origin patterns from the selected model and stored non-secret endpoint configuration.

- Authentication requests only provider setup origins needed for that flow.
- API-key setup does not request unrelated OAuth origins.
- **Test Connection** requests the selected model endpoint origin from Options before sending data.
  - The background checks the endpoint permission again without requesting access itself.
  - A denied permission or untrusted administrative sender cannot start a translation request.
- Page, selection, subtitle, and PDF translation verify the same endpoint permission before each session.
- Radius can require both its configuration origin and the selected gateway/model origin.
- Permission diagnostics include origins, never API keys, tokens, prompts, or translated text.

If endpoint access is denied or later revoked, translation stops and Options reports the missing permission.

## Browser implementation note

`pi-ai` provider definitions use lazy API and OAuth adapters by default. Manifest V3 service workers cannot execute Node callback servers or load those adapters dynamically after startup, so Vibe Translator statically registers the nine text APIs and browser-specific OAuth flows used by its provider catalog while retaining `pi-ai` provider, model, credential-refresh, request, and response behavior. The build rules in `scripts/browser-sdk-rules.mjs` keep only the OpenAI Responses/Chat Completions, Anthropic beta Messages, and Google streaming-content SDK resources used by those adapters. Required upstream classes, resources, and methods are checked before unused SDK code is removed. Repeated catalog metadata is emitted through factories that preserve every model value and keep nested metadata independently mutable. Regression tests exercise the trimmed browser SDKs with local streaming fixtures and compare every encoded catalog with the installed SDK data. The production artifact check rejects Node built-in imports and verifies the reviewed size budget.
