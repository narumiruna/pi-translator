# Manual Testing

## Test pages

1. Run `npm run build`, then load `dist/chrome` from `chrome://extensions/`
2. Serve `test/fixture-page.html` from a local HTTP server and open it in Chrome
3. Prepare one additional article-style page with more content than one viewport so scroll-triggered queuing is easy to verify
4. Prepare one page containing inline code, file paths, URLs, or math so protected fragment rendering can be checked

## Options page

1. Open the extension options page
2. Select **Custom OpenAI-compatible**, add an API key in the authentication dialog, and save a valid `/v1` base URL, model, target language, system prompt template, and user prompt template
3. Confirm the secret disappears when the dialog closes, the provider reports that an API key is configured, and no password field remains in the page
4. Confirm the endpoint permission status reflects the selected model origin; click **Test Connection**, approve only that origin, and confirm the status shows a sample translation
5. Edit the target language and confirm both prompt preview panes update immediately
6. Edit the system prompt template and confirm the system preview updates immediately
7. Edit the user prompt template and confirm the user preview updates immediately
8. Click **Reset System Template** and confirm the template and preview return to the default value
9. Click **Reset User Template** and confirm the template and preview return to the default value
10. Select **Calm Reading**, **Minimal**, and **High Contrast** and confirm every related inline control and the live preview update; confirm the save bar reports unsaved preview changes
11. Change any Typography, Layout, or color field and confirm the preset changes to **Custom**
12. Toggle the Light/Dark preview and confirm each mode uses its independent saved colors
13. Set text and background to the same color and confirm a WCAG warning appears without blocking Save
14. Disable the translation background and confirm the contrast status says host-page contrast cannot be verified
15. Customize the selection panel width, typography, radius, opacity, and colors and confirm its independent preview updates
16. Click **Reset Appearance** and confirm only appearance controls return to Calm Reading; API, prompts, target language, and disabled domains remain unchanged
17. Save custom appearance settings, confirm the save bar reports no unsaved changes, reload options, and confirm every inline and selection value persists
18. Change **Selection Panel** to **Near selected text**, save, reload, and confirm the selection is preserved
19. Change **Selection Panel** to **Bottom-right corner**, save, reload, and confirm the selection is preserved
20. Select each **YouTube Subtitles → Display Mode** radio option with the keyboard and confirm its full label and description are announced by a screen reader
21. Save each YouTube subtitle display mode, reload Settings, and confirm the selected mode persists; confirm a profile without the setting opens as **Translation only**
22. Save disabled domains using mixed case and comma or newline separators, reload the page, and confirm they are normalized to lowercase hostnames with one hostname per line
23. Upgrade a profile containing only legacy underline settings and confirm it opens as Calm Reading without validation errors
24. Use Left/Right Arrow on the Setup, Appearance, Prompts, and Advanced tabs and confirm focus, selected state, and the visible panel move together without losing drafts
25. Use only the keyboard to edit each control, open and close every Appearance disclosure, reset prompts and appearance, run Test Connection, recover from an error, and save without a focus trap
26. Check Setup, Appearance, Prompts, and Advanced with a screen reader and confirm tabs, labels, descriptions, radio groups, selected states, validation errors, permission status, and connection status are announced with their controls
27. Review the options page in light and dark modes at 320 px, 390 px, 720 px, desktop width, 200% zoom, reduced motion, and forced colors; confirm there is no horizontal overflow or obscured save action
28. Enter a valid URL that omits `/v1`, submit, and confirm Base URL is marked invalid, references the visible error, and clears its invalid state after correction
29. Trigger Test Connection twice rapidly and confirm only one request runs while the button remains disabled until the operation settles
30. Simulate a connection failure, confirm the same status area provides actionable recovery, retry, and confirm success without reloading the page
31. Inspect the packaged options page network and console output and confirm it loads no remote UI resource, emits no page error, and never exposes an API key or token
32. Search providers by name and ID, search a large model catalog by name and ID, choose results with mouse and keyboard, and confirm Escape restores the current selection; close an API-key prompt with Cancel and confirm no credential is replaced
33. Clear **Model**, switch to Prompts, and save; confirm Setup opens, Model receives focus, and the error is announced. Repeat under **Custom OpenAI-compatible** with a URL that omits `/v1` and with a User Prompt that omits `{{sourcePayload}}`
34. Set an out-of-range Appearance number, close its disclosure, switch tabs, and save; confirm Appearance opens, the disclosure expands, and the invalid control receives focus without losing other drafts
35. Scroll to the top, middle, and bottom of each tab in light and dark modes; confirm both save-bar actions remain inside the viewport and clickable. With reduced motion, confirm both preview fades and disclosure animations are disabled
36. Select a reasoning model and confirm **Thinking Level** lists only its supported levels plus **Default**; select a non-default level with the keyboard, save, reload, and confirm it persists
37. Switch to a model that does not support the saved level and confirm it is marked unavailable, the description explains the fallback, and switching back preserves the preference; choose **Default** to restore existing behavior
38. Under **Custom OpenAI-compatible**, confirm levels stop at **High**; with a compatible mock endpoint, test **Default**, **Off**, and **High** and confirm requests omit reasoning, send `none`, and send `high`, respectively
39. Translate the same source after changing Thinking Level and confirm neither page nor PDF cache reuses results from the previous level

## Provider authentication

1. Configure and test at least one OpenAI Responses, Anthropic Messages, Google, and OpenAI Completions provider; confirm each request uses the selected provider/model and only its endpoint origin is granted
2. Configure Cloudflare Workers AI and AI Gateway; confirm the dialog collects account/gateway IDs, permission status contains no identifier or secret, and translation succeeds
3. Configure Azure OpenAI; confirm the dialog collects its base URL, optional API version, and deployment map and requests only the Azure resource origin
4. Configure Google Vertex with a Cloud API key and confirm no Application Default Credentials or local-file option is offered
5. Configure Radius with an API key, approve its configuration origin, and confirm its model list appears after authentication
6. For a provider with both methods, choose **Configure authentication** and confirm **Select authentication method** offers account sign-in before API-key sign-in
7. Complete the device-code account flow for OpenAI Codex, GitHub Copilot, Kimi For Coding, Radius, and xAI; cancel each once first and verify no credential is stored
8. Complete the Anthropic and OpenRouter account flows by opening the sign-in page and pasting the final redirect URL or authorization code; confirm the PKCE exchange completes
9. Run **Test Connection**, force **Refresh credential**, reload Options, and confirm each account status remains configured without displaying either token
10. Remove each test credential and confirm translation is blocked until that provider is configured again
11. Revoke one granted OAuth authentication origin in Chrome extension site access and confirm only the affected provider credential is invalidated
12. Inspect `chrome.storage.sync` and confirm it contains provider/model settings but no `apiKey`, access token, or refresh token; confirm credentials exist only in trusted local extension storage
13. Upgrade a profile with legacy `apiKey`/`baseUrl` settings and confirm the secret moves to local provider credentials, standard OpenAI maps to OpenAI, custom URLs map to **Custom OpenAI-compatible**, and sync storage no longer contains the secret
14. From a normal page/content context, attempt to open the authentication port and confirm it disconnects without exposing prompts, status, or credentials

## GitHub issue comments

1. Open `https://github.com/earendil-works/pi/issues/5350` and start page translation.
2. Scroll through the discussion. Confirm that body and comment prose receive inline translations, including comments inside `shared__` timeline wrappers.
3. Confirm that inline code stays unchanged and that share controls do not receive translations.
4. After a production build, run `PLAYWRIGHT_ENV_FILE=/dev/null PLAYWRIGHT_HEADLESS=1 npm run e2e:github`. This uses a local fixture and mock provider to check comment coverage, scrolling, dynamic comments, and duplicate notes. It does not verify live-provider output.

## PDF translation

1. Build and load `dist/chrome`, configure the translation API, and open `https://www.cs.princeton.edu/~chazelle/courses/BIB/jeannette-wing.pdf`
2. Click the Vibe Translator toolbar action and approve only the PDF origin when Chrome requests permission
3. Confirm a new Vibe PDF Reader tab opens while the original PDF tab remains available
4. Confirm the reader URL contains only an extension launch token and not the source URL or its query parameters
5. Confirm all three original pages render, their text remains selectable, and page navigation and zoom work with mouse and keyboard
6. Confirm the translation pane starts with the visible page and nearby pages, then fills progressively without replacing the original PDF
7. Confirm page headers, footers, and page numbers are not translated as body paragraphs
8. Confirm the Princeton paper's multi-column text reads down the left column before continuing down the right column
9. Click a translated block and confirm its matching source lines are highlighted on the original page
10. Search translated text and use Copy page and Copy document after results are available
11. Click **Translate entire document**, review the character estimate, cancel once, then confirm and verify finite progress
12. Pause before scrolling to a new page and confirm no new page batch starts until Resume is selected
13. Simulate one failed API chunk, confirm successful blocks remain, click **Retry failed**, and confirm only failed blocks retry
14. Choose `test/fixtures/pdf/encrypted.pdf`, enter `vibe-test`, and confirm the local encrypted document opens without persisting the password
15. Choose `test/fixtures/pdf/malformed.pdf` and confirm an actionable error appears without replacing the current readable document
16. Choose a scanned PDF and confirm the reader reports that OCR is not supported when extractable text is insufficient
17. Test a PDF larger than the supported byte, page, or text limit and confirm it fails before unbounded rendering or translation work
18. Test a URL that redirects to another origin and confirm it offers local file selection rather than following an unauthorized source
19. Deny the source-origin permission and confirm the original PDF remains open and no reader session starts
20. Disable the PDF hostname in Settings and confirm translation is rejected for that source
21. Reload the PDF reader while translation is in progress and confirm it reconnects through the tab-bound launch token without duplicate visible results
22. Close the reader during translation and confirm late API results are suppressed without affecting another reader tab
23. Verify the reader at 320 px, 390 px, desktop width, 200% zoom, reduced motion, dark mode, and forced colors with no obscured controls or horizontal page UI overflow
24. Inspect extension logs and confirm they contain no PDF text, password, signed source URL, prompt, API key, authorization value, or API response
25. Run `PLAYWRIGHT_HEADLESS=1 npm run e2e:pdf` and confirm the local fixture, partial failure, retry, navigation, encrypted file, and cancellation checks pass without external network access

## Entire page translation

1. Open the long article-style test page
2. Click the extension icon
3. Confirm only visible content and roughly the next two viewports begin with shimmer placeholders
4. Confirm deeper content below that window does not start translating yet
5. Confirm each completed translation is inserted after the source block instead of replacing the original text
6. Confirm headings remain headings, list items remain list items, and table cells remain table cells
7. On `test/fixture-page.html`, confirm table-cell translations render inside cells and do not add extra table columns
8. Confirm translations use the saved preset or Custom inline font, width, spacing, surface, accent, radius, label, animation, and active light/dark colors
9. Save a different appearance while the article remains open and confirm existing notes stay unchanged until the page is translated again
10. Confirm the action badge changes from empty to a numeric count as page translations complete
11. Scroll downward and confirm newly visible blocks are queued and translated automatically
12. With mock API delay or browser network throttling enabled, start translation and rapidly jump several viewports downward while earlier requests remain pending; confirm the new visible block receives a pending note after the first active request finishes, without waiting for the earlier prefetched backlog
13. While requests remain pending, immediately scroll upward; confirm restored visible blocks take priority at the next available request slot and existing completed notes remain unchanged
14. Stop scrolling in each direction and confirm the current viewport plus its prefetch window drains to completion without another scroll event
15. Repeat the jump inside a nested overflow container; confirm no more than five ordinary pending notes appear, every source remains readable beside its pending note, and scrolling away and back creates no duplicate completed note
16. Right-click a blank area and choose **Translate entire page** again
17. Confirm existing notes are updated in place instead of duplicated and now use the latest saved appearance
18. Test zero spacing/padding and maximum legal spacing/width in a table, list, `pre`, and narrow viewport; confirm there is no horizontal page overflow
19. Reset to **Calm Reading** and confirm each translation is a compact secondary line with a thin neutral accent, an explicit **Translation** label, and no card background
20. Translate a GitHub pull request and confirm conversation content is translated while the Development and Notifications sidebars remain untouched
21. Confirm there is no per-block display toggle UI and no page-level display mode toolbar

### Flex/grid layout regression

1. Run `node e2e/layout-regression.cjs` to check flex/grid placement at 1440 px and 390 px, repeated rendering, source-text isolation, dynamic text replacement, and a page button. CI runs this regression after installing Chromium.
   - Sources with internal flex/grid layout, clipping, or a non-auto height must use visible sibling notes under safe flow or column-flex parents.
   - Check fixed heights from stylesheet rules, logical `block-size`, and vertical `flex-basis`. Notes must not overlap the next item. Auto-height sources without a fixed flex basis must still contain their notes. Height changes must update placement without duplicate notes.
   - When a responsive parent changes to an unsafe row/grid layout, fallback notes must hide without changing the source. They must return when a safe placement is available.
   - Sources without a safe internal or sibling placement are skipped before queueing rather than changing host-page CSS. Check both semantic and fallback extraction, repeated collection, and recovery after the layout becomes safe.
   - Table-cell notes must stay inside their cells. Constrained cells without a safe internal placement must be skipped; never insert a note directly under a table row.
2. Open `https://anthologyresearch.ai/roles/ml-systems-engineer-kernels-inference-1a4903/i` with the built extension. Translate at desktop width, then resize to 390 px. Confirm the body remains readable and no horizontal overflow is added.
3. Confirm the translated salary lines retain `$50–$150/hr`, `$35–$120/hr`, and `$25–$80/hr` without internal placeholders.
4. Repeat translation, test available translation controls, and open the FAQ items. Confirm notes do not accumulate and page links and controls still work.

## YouTube subtitle translation

1. Open an auto-caption watch page, including `https://www.youtube.com/watch?v=R3-anFK1YM8`
2. Confirm the Vibe Translator icon appears beside YouTube’s caption control and remains inside the video frame
3. In Settings, choose **Translation only**, then click the in-player icon and confirm its diagnostic panel immediately reports that the click was received
4. Confirm the icon turns active, the diagnostic panel reports startup progress, and available native captions are enabled
5. Confirm the panel records sanitized track source, timed-prefetch availability, caption extraction, queueing, playback rate, window placement, cache path, fallback coalescing, API completion or failure, and render outcomes
6. Use **Copy diagnostics** and confirm the report contains player/control/caption pipeline state but no API key, prompt, source caption text, API response text, or timed-caption URL
7. At 1×, confirm diagnostics report `rate=1`, a 60,000 ms window, front placement at startup, and back placement for rolling refills
8. Play the video and confirm each completed prefetched translation appears immediately; allow the original caption to remain while the initial API batch is still warming up
9. Change playback to 1.5× and confirm diagnostics report a 90,000 ms window without restarting translation
10. Change playback to 2× and confirm diagnostics report a 120,000 ms window without restarting translation
11. Watch consecutive cues at each speed and confirm prefetched cues do not enter visible-caption fallback after the rate-specific window is ready
12. On `R3-anFK1YM8`, confirm progressive fragments produce exact or `timed-prefix` hits only while their unique timed cue is active, with no repeated unexplained missing targets
13. On a video where timed prefetch is unavailable, confirm diagnostics show at most one active visible fallback per caption slot and coalesce later mutations to the latest pending text
14. Let the initial caption-visibility timeout appear before playback, then play until native captions appear and confirm the icon returns from the recoverable error to active without another click
15. In **Translation only**, confirm only the native segment owned by the current translation is hidden; sibling native segments remain visible until their own translations are ready
16. Confirm translated subtitles use the compact player style without the inline translation label or shimmer placeholder
17. Change Settings to **Original and translation**, restart subtitle translation, and confirm each native cue remains visible with its matching translated line directly below it
18. Watch several consecutive cues, including cumulative auto-generated captions, and confirm each old translation disappears in the same cue transition instead of surviving over newer native text
19. Find a caption window with multiple simultaneous segments and confirm each translation stays attached to its exact source while removing one segment leaves valid siblings intact
20. Continue playing for more than one real-time minute at 1×, 1.5×, and 2× and confirm rolling tail refills do not overtake nearer pending cues
21. Seek forward to an untranslated position and confirm the new window uses front placement before its matching cue appears
22. Seek backward while translation is pending and confirm an older result is classified as superseded and never replaces the current cue
23. Confirm a caption segment replaced by YouTube while its translation is pending still renders when the visible source text is identical
24. Enter and leave fullscreen in each display mode and confirm the icon, native captions required by the mode, and translated subtitles remain readable and inside the player
25. Navigate to another YouTube video without reloading and confirm the icon returns to idle, caption-slot state is cleared, and the saved display mode is retained when translation restarts
26. Click the pinned Chrome toolbar icon and confirm its existing whole-page translation behavior is unchanged
27. Open a video where YouTube exposes a caption track but renders no native caption text, click the in-player icon, wait about five seconds, and confirm the icon and diagnostic panel report that captions are not visible instead of staying falsely active
28. Clear required API settings, click the in-player icon, and confirm the icon visibly enters a non-recoverable error state, the diagnostic panel shows the failure, and Settings opens instead of appearing inert

### Long-playback recovery

Use the built extension and a mock provider for automated failure tests:

```sh
npm run check
npm run e2e:youtube
# CI: packaged recovery cases without the public YouTube smoke
npm run e2e:youtube -- --fixture-only
```

The suite first checks player control placement, content injection, and startup on an unmodified public YouTube page. Detailed recovery cases use synthetic video IDs on the existing YouTube origin, the packaged content script and background worker, and a local mock API. The real-page smoke requires network access to YouTube. No live translation API calls are required. It stops the actual worker with CDP `ServiceWorker.stopWorker`, checks stopped/running events, and verifies that a worker-global probe disappears after restart. Worker target IDs can remain unchanged.

For a production-browser check:

1. Start subtitle translation. Keep the worker inspector closed during normal playback.
2. Stop the extension worker, then continue playback or resume after a pause longer than 30 seconds. Confirm that diagnostics show `session-lost`, one coordinated recovery, and `recovery-success` without another click.
3. Repeat when timed captions are unavailable. Confirm that visible-caption translation resumes and playback status checks continue.
4. Use the mock server to send SSE headers without completing the response. Confirm that the subtitle batch stops after 30 seconds, the connection closes, and a later caption can translate. Repeat with five concurrent stalled batches; the limit must remain five.
5. Reject a visible-caption request twice. Confirm that the same snapshot gets only one automatic retry, the native caption stays readable, and the control shows an actionable error. Change the caption and confirm that a transient error does not block the new snapshot. Configuration or permission errors must not retry automatically.
6. Replace the video node without changing the video ID. Confirm that progress, seek, and rate updates come from the replacement, with no duplicate listeners on the old node.
7. Seek during recovery, then navigate to a different video before a delayed recovery completes. Confirm that old startup, result, failure, and diagnostic messages cannot change the new video.
8. Test both subtitle display modes. Confirm that untranslated native segments remain readable and that completed offscreen translations can still enter the cache.
9. Seek through cues beyond 10 and 20 minutes. This tests timeline handling; it is not evidence of 20 minutes of continuous playback.
10. Force recovery to fail three times. Confirm that attempts start at least ten seconds apart, automatic recovery stops after the third failure, and a player-control click can restart it. Successful startup alone must not reset the retry budget; successful translation delivery can reset it.
11. Copy diagnostics after each injected fault. Confirm that the report identifies the failure stage without API keys, prompts, source captions, response bodies, or signed caption URLs.

Navigation, content teardown, and terminal failure send cancellation scoped to the old session or startup request. A delayed cancellation must not abort a newer startup. Cancellation on a non-YouTube page must not affect its page translation session.

Recovery and subtitle batch deadlines are internal constants. The background attempt has a 30-second deadline; content allows one additional second for delivery of its result. No new settings, permissions, persisted caption data, or background keep-alive loop are required.

### Automated evidence (2026-10-21)

- Formatting, lint, module checks, 460 unit tests, production build, and artifact verification passed. The bundle still reports performance-budget and PDF `tabs` compatibility warnings; no permissions were added to suppress them.
- Packaged tests cover four actual worker stops, 31-second pauses, five real stalled SSE connections, the 30-second deadline, healthy SPA request cancellation, stale-message rejection, video replacement, both display modes, and cues at 600,000 and 1,200,000 ms.
- Mock page, selection, iframe, reinjection, partial-failure, appearance, PDF, desktop/mobile layout, and fixed-height placement browser regressions passed. The Chrome ZIP was built and verified locally; no package or release was published.
- CI runs the complete packaged fixture suite with `--fixture-only` and explicitly logs that the public-page smoke was not run. GitHub-hosted runners displayed YouTube's “Sign in to confirm you're not a bot” page; native controls were unavailable. The default command still requires the real-page smoke, which passed locally.
- CI uploads fixture screenshots in the `vibe-translator-chrome` artifact under `e2e-artifacts/`, including `youtube-recovery-visible-bilingual.png`, `youtube-recovery-after-sse-timeout.png`, and `youtube-recovery-exhausted.png`. The local real-page capture is `youtube-live-player.png`. Screenshots are not committed.

### Remaining live checks

These checks are separate from automated-plan completion:

- **Hosted-runner live smoke — CI maintainer:** Use a runner with legitimate access to a playable public YouTube page, then run the default `npm run e2e:youtube` command without `--fixture-only`. Expected result: real player controls, content injection, and startup pass with the mock provider. The public-page smoke is blocked by YouTube's bot check on the current GitHub-hosted runner. Do not claim real-page CI validation until it passes on an accessible runner. Do not bypass the bot check or use credentials in test artifacts.
- **Incident diagnosis — affected user:** With the failing video and installed extension, copy diagnostics when translation stops. Record playback time, any pause or ad transition, and whether native captions still update. Expected result: identify the failure stage without sharing credentials. The cause of the original incident is still unconfirmed; synthetic recovery tests alone do not establish that it is resolved.
- **Live-provider soak — account owner or authorized tester:** With a configured provider and approval for API usage, play a captioned video for at least 20 real-time minutes. Include pause/resume and an ad transition when available. Capture sanitized diagnostics. Expected result: continued translation or a bounded, actionable error. Live provider delays, account limits, and YouTube runtime changes remain unverified until this check is recorded. Do not claim live-provider long-playback validation before then.

## Selection translation

1. Select a sentence on any supported page
2. Right-click the selected text
3. Choose **Translate selected text**
4. With **Selection Translation Panel** set to **Near selected text**, confirm a floating selection translation panel appears near the selected text and stays within the viewport
5. Confirm the panel first shows `Translating to …` with a three-line shimmer state and then atomically replaces it with translated text
6. Confirm the short `Translation` title, full target-language chip, and close control remain visible without ambiguous truncation
7. Confirm the original page content stays unchanged and no redundant success toast appears
8. Confirm the panel uses its independent saved width, font size, line height, radius, opacity, and active light/dark colors rather than inline-card spacing or fonts
9. Use a long result and confirm **Show more**/**Show less** changes only panel height, never its configured width
10. Resize to a 320px viewport and confirm the panel reflows inside the viewport without horizontal overflow
11. Use Tab to confirm visible controls have a focus indicator, then press `Escape` and confirm the panel is removed
12. Dismiss a panel while it is still translating and confirm the completed result does not reopen it
13. Run selection translation again and confirm the panel can be reopened normally
14. Confirm the action badge shows `TR` after a successful selection translation
15. Switch **Selection Panel** to **Bottom-right corner** and confirm the panel opens near the bottom-right instead
16. Select text inside the iframe on `test/fixture-page.html` and confirm the panel appears inside that iframe, not in the top page, with the same panel-specific appearance
17. Enable reduced motion and confirm panel entrance and shimmer animations are disabled

## Protected fragments

1. Open a page containing inline code, file paths, URLs, or math expressions
2. Run page translation or selection translation on text that includes those fragments
3. Confirm inline code is still rendered as code instead of plain translated prose
4. Confirm URLs, file paths, commands, identifiers, and common product names remain unchanged in the translated result
5. Confirm math content stays intact and is not replaced with broken placeholder text

## Dynamic content

1. Start page translation on a page that can be edited or updated after translation begins
2. Change the text of an already translated block, or use a page that injects additional readable content dynamically
3. Confirm the previous translation note becomes visually stale before the updated content is re-queued
4. Confirm toggling a class or style without changing text does not make the previous translation note stale or re-queue the block
5. Confirm the changed block is translated again once it is within the active translation window
6. Add readable blocks above and below the current position, then rapidly scroll down and back up while requests are delayed; confirm whichever block is visible moves ahead of older unclaimed work
7. Stop scrolling and confirm all eligible blocks in the active translation window finish without another mutation or scroll event
8. Confirm newly inserted readable blocks are picked up when they scroll into view and are not duplicated after scrolling away and back

## Disabled domains

1. Add the current test page hostname to **Disabled Domains** and save
2. Return to that page and click the extension icon
3. Confirm page translation is blocked and an error toast is shown
4. Select text on the same page and choose **Translate selected text**
5. Confirm selection translation is also blocked
6. Remove the hostname from **Disabled Domains**, save again, and confirm both page and selection translation work normally

## Extension.js development and reinjection

1. Run `npm run dev` and confirm Extension.js reports background, content, options, and page contexts with timestamps
2. Open `dist/extension-js/chrome/ready.json` and confirm the development build reaches a ready state
3. Start page translation, edit a content entry module, and confirm one reload occurs without duplicate notes, runtime responses, observers, or API requests
4. On YouTube, edit a content or control module and confirm only one Vibe Translator control and one delegated click handler remain
5. Open and dismiss a selection panel, trigger reinjection, and confirm `Escape` and resize behavior run once
6. Filter development logs by context label, URL, tab, and event name and confirm API keys, authorization values, prompts, selected text, source text, and response bodies are absent
7. Run `PLAYWRIGHT_HEADLESS=1 npm run e2e:mock` twice with temporary profiles and confirm both runs pass

## Session teardown

1. Start translating a longer page
2. While translations are still appearing, reload the tab
3. Confirm translation stops quietly, pending placeholders disappear with the reload, and the action badge is cleared
4. Start another page translation run and confirm it works normally after the reload
5. Start translating again and close the tab before the run finishes
6. Confirm the extension does not show a hard failure for the closed tab and other tabs continue working normally

## Error handling

1. Remove the selected provider credential and click the extension icon
2. Confirm the options page opens instead of sending a translation request
3. Under **Custom OpenAI-compatible**, use an invalid base URL and confirm save validation fails
4. Remove `{{sourcePayload}}` from the user prompt template and confirm save validation fails
5. Click **Test Connection**, deny the API origin permission request, and confirm the options page shows a permission-related error state
6. Deny API origin permission during page or selection translation and confirm an error toast is shown on the page
7. Simulate one failed page-translation API chunk and confirm successful translations remain while a partial-failure toast is shown
8. Simulate a selected-text API failure after loading starts and confirm the same panel shows an actionable alert with **Try again**
9. Restore the API, click **Try again**, and confirm the control is disabled during loading and the panel reaches the ready state
10. Trigger two selection requests in quick succession and confirm a late result from the older request cannot replace the newer result or badge state
11. Open `chrome://extensions/` and confirm translation is rejected safely without injecting UI

## Reliability and security regression (2026-10-23)

### Reproducible local checks

Run the production checks and local browser fixtures without loading account configuration:

```sh
npm run check
export PLAYWRIGHT_ENV_FILE=/dev/null
export PLAYWRIGHT_HEADLESS=1
export PLAYWRIGHT_MOCK_API=1
export OPENAI_API_KEY=mock-api-key
export OPENAI_MODEL=mock-model
unset PLAYWRIGHT_USER_DATA_DIR
node e2e/layout-regression.cjs
npm run e2e:mock
node e2e/page-lifecycle.cjs
node e2e/page-source-revisions.cjs
npm run e2e:options
npm run e2e:github
npm run e2e:pdf
npm run e2e:youtube -- --fixture-only
```

The suites use temporary Chromium profiles and synthetic credentials.
The page lifecycle suite includes a real 120-second wait; allow a 300-second command timeout.
It dispatches through the packaged worker's registered Chrome action and context-menu Event bindings, not the translation automation message.
This checks listener wiring but does not operate Chrome's physical toolbar or native context-menu UI.
The layout suite exercises source runtime code; the extension suites load the production artifact.

| Regression | Required evidence |
| --- | --- |
| Long text packing | The 7,898-character, 1,001-word unit fixture produces two bounded chunks and reconstructs the source exactly; IDs, placeholders, and progressive merge remain correct. |
| Superseded startup | Toolbar and context-menu paths retain the replacement session after delayed old extraction success or failure; replacement settings failure also retires the aborted startup's own session. |
| Changed source | A to B to C changes while A is active produce only a C ready note, after either old success or failure, without scrolling or overlapping same-source requests. |
| Session message ownership | Old session IDs cannot render, add placeholders, clear placeholders, or deactivate the replacement; unrelated selection setup failures leave a page session active. |
| Administrative boundary | Content-script senders and denied endpoint permissions produce no translation call; actual Chrome content contexts cannot read or write trusted local or sync storage. |
| PKCE | Synthetic exchanges verify independent state, the S256 challenge, callback forms, mismatches, missing structured state, and cancellation; no real account is used. |
| Cancellation | Reload and close terminate page SSE transports; PDF replacement, Cancel, and disconnect terminate their stalled transports without affecting replacement work. |
| Batch deadline | Five actual stalled page requests close after 120 seconds, their queue slots are released, and the sixth source translates; subtitle requests keep their existing 30-second deadline. |
| Settings quota | Real Chrome accepts 8,192-byte items and rejects 8,193-byte items with ASCII, CJK, and emoji; oversized drafts fail before a write, retain edits, and do not overwrite saved settings. |
| PDF navigation | A six-page fixture renders and translates page 4 after three Next actions, returns with Previous, and synchronizes both panes under computed instant scrolling; normal scrolling and repeated observer events do not duplicate provider items. |
| Authentication dialog | Initial focus, Tab and Shift+Tab containment, Escape/Cancel, focus restoration, background isolation, and secret cleanup pass for key, method, and synthetic account flows in light/dark, narrow, and reduced-motion modes. |

### Verification evidence

The implementation baseline passed 466 tests and the original Options UI suite.
Each defect received a failing regression before its fix.
The complete implementation passes 583 unit tests, Biome checks, module syntax checks, the production build, and artifact verification.
The packaged suites listed above passed locally with mock providers.
The PDF navigation fixture contains 48 blocks across six pages; navigation reaches all 48 provider item IDs without duplicates.
The Options dialog checks also exposed a solid-button contrast failure; its primary actions now use the existing high-contrast treatment.
One delegated lifecycle run was interrupted with exit 137 before its deadline check finished; it was not counted as passing.
The same full lifecycle suite subsequently passed on the final artifact under a direct 300-second runner, including the actual 120-second deadline.
No real provider account, paid API, public YouTube live smoke, or release publication was used for this work.

Before-change Options captures are under `e2e-artifacts/reliability-before/`.
After-change local captures are under `e2e-artifacts/reliability-options-after/` and `e2e-artifacts/pdf-reliability/`.
CI produces the equivalent captures in its `vibe-translator-chrome` artifact under `e2e-artifacts/`, including `options-auth-api-key-light.png`, `options-auth-method-dark.png`, and `pdf-six-page-navigation.png`.
Screenshots and binary fixtures generated by these tests are not committed.

### Artifact review

The reviewed unpacked artifact remains below the existing 4,100,000-byte budget.
The current total is 4,082,248 bytes; no budget was increased.

| Artifact group | Unpacked bytes | Existing budget |
| --- | ---: | ---: |
| Background service worker | 1,247,575 | 1,450,000 |
| Options files | 788,220 | 950,000 |
| PDF reader and standalone worker | 1,656,080 | 1,700,000 |
| Complete extension | 4,082,248 | 4,100,000 |

The build still reports the existing background/PDF-worker performance warnings and PDF `chrome.tabs` compatibility warning.
The PDF reader only uses `chrome.tabs.create`; no broad `tabs` permission was added to suppress that warning.
The largest retained payloads are the streaming provider SDK/catalog background bundle, the PDF.js worker, Radix component CSS, and the PDF.js reader.
Their owners are `src/auth/browser-apis.js`, `scripts/browser-sdk-rules.mjs`, the Options stylesheet imports, and `src/pdf/index.js`.
A separate optimization must measure dependency contributions and cold-start timing before changing these payloads.
These size checks do not establish a startup-speed improvement.

### External acceptance and release restrictions

- **Anthropic account owner:** With legitimate account access and consent to sign in, test the candidate's manual OAuth handoff, cancellation, and credential refresh as specified in [Authentication and providers](AUTHENTICATION.md).
  - Expected result: independent state is accepted, refresh succeeds, and cancellation stores no credential.
  - Unverified behavior: real Anthropic authorization and token-service compatibility.
  - Release restriction: do not release the changed Anthropic flow before this check passes; do not share secrets or callback URLs as evidence.
- **Authorized live-provider tester and CI maintainer:** Use approved API access and a legitimately accessible public video to complete the existing [Remaining live checks](#remaining-live-checks).
  - Expected result: continued translation or a bounded, actionable failure.
  - Unverified behavior: provider latency, account limits, public YouTube runtime behavior, and provider-side billing termination.
  - Release restriction: local abort tests do not prove a refund, live-provider soak, or public-page CI access; do not bypass bot checks.
- **UI maintainer:** With the candidate loaded through Chrome's native extension UI, inspect the retained captures, operate the physical toolbar/context menu, and perform any required screen-reader or subjective visual review.
  - Expected result: readable dialogs and correct native action access.
  - Unverified behavior: physical browser UI operation and real screen-reader announcements are not established by DOM, Event-binding, or axe checks.
  - Release restriction: do not describe those native or subjective checks as completed without separate evidence.

Local implementation completion does not establish external product acceptance or release readiness.
