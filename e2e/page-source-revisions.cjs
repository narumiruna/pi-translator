#!/usr/bin/env node

const assert = require("node:assert/strict");
const {
	ROOT_DIR,
	callBackground,
	closeExtensionContext,
	createMockApiServer,
	createStaticServer,
	getConfig,
	launchExtensionContext,
	saveOptions,
	waitFor,
} = require("./lib/extension-test-helpers.cjs");

async function main() {
	// This regression must never load account settings or use an existing profile.
	process.env.PLAYWRIGHT_ENV_FILE = "/dev/null";
	process.env.PLAYWRIGHT_MOCK_API = "1";
	const config = getConfig();
	const server = await createStaticServer(ROOT_DIR);
	const mock = await createMockApiServer();
	Object.assign(config, {
		apiKey: "mock-api-key",
		baseUrl: mock.baseUrl,
		model: "mock-model",
		targetLanguage: "Traditional Chinese (Taiwan)",
		userDataDir: "",
	});
	let runState;
	try {
		runState = await launchExtensionContext(config, [`${server.origin}/*`]);
		assert.equal(runState.isTemporaryUserDataDir, true);
		await saveOptions(runState.context, runState.extensionId, config);
		const worker = runState.context
			.serviceWorkers()
			.find(
				(candidate) =>
					new URL(candidate.url()).hostname === runState.extensionId,
			);
		await worker.evaluate(() => {
			globalThis.__sourceRevisionMessages = [];
			globalThis.__sourceRevisionListener = (message) => {
				if (message.type === "queue-page-translation-items") {
					globalThis.__sourceRevisionMessages.push(
						...(message.payload.items || []).map((item) => item.text),
					);
				}
			};
			chrome.runtime.onMessage.addListener(globalThis.__sourceRevisionListener);
		});
		for (const outcome of ["success", "failure"]) {
			const page = await runState.context.newPage();
			const pageUrl = `${server.origin}/test/page-source-revisions.html?outcome=${outcome}`;
			await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
			const text = (revision) =>
				`Revision ${revision} ${outcome}: This ordinary paragraph changes while its original translation request is still active. Only the latest source revision can receive a ready translation.`;
			await page.evaluate((initialText) => {
				document.querySelector("#source").textContent = initialText;
				window.__readyTranslations = [];
				window.__revisionObserver = new MutationObserver(() => {
					for (const body of document.querySelectorAll(
						'[data-ot-role="note"][data-phase="ready"] [data-ot-role="note-body"]',
					)) {
						window.__readyTranslations.push(body.textContent);
					}
				});
				window.__revisionObserver.observe(document.body, {
					childList: true,
					subtree: true,
					attributes: true,
					attributeFilter: ["data-phase"],
				});
			}, text("A"));
			const before = mock.getResponseRequestCount();
			mock.delayNextResponses(4000);
			mock.setFailOnTextIncludes(
				outcome === "failure" ? "Revision A failure" : "",
			);
			await callBackground(runState.context, "translatePage", { pageUrl });
			await waitFor(() => mock.getResponseRequestCount() > before);
			for (const revision of ["B", "C"]) {
				await page.locator("#source").evaluate((source, nextText) => {
					source.firstChild.textContent = nextText;
				}, text(revision));
				await waitFor(
					() =>
						worker.evaluate(
							(snapshot) =>
								globalThis.__sourceRevisionMessages.includes(snapshot),
							text(revision),
						),
					{
						timeoutMessage: `Revision ${revision} was not queued without scrolling.`,
					},
				);
				assert.equal(
					mock.getResponseRequestCount(),
					before + 1,
					"A second revision must not start while A is active.",
				);
				assert.equal(await page.locator('[data-phase="ready"]').count(), 0);
				assert.equal(
					await page.locator("#source").getAttribute("data-ot-source-stale"),
					"true",
				);
			}
			await waitFor(
				async () => {
					const body = page.locator(
						'[data-ot-role="note"][data-phase="ready"] [data-ot-role="note-body"]',
					);
					return (
						(await body.count()) === 1 &&
						(await body.textContent()).includes(`Revision C ${outcome}`)
					);
				},
				{
					timeoutMs: 60000,
					timeoutMessage: `Latest revision C did not become ready after old ${outcome}.`,
				},
			);
			await waitFor(() => mock.getActiveResponseCount() === 0);
			const result = await page.evaluate(() => ({
				ready: window.__readyTranslations,
				stale: document
					.querySelector("#source")
					.getAttribute("data-ot-source-stale"),
				translated: document
					.querySelector("#source")
					.getAttribute("data-ot-translated"),
				notes: document.querySelectorAll('[data-ot-role="note"]').length,
				pending: document.querySelectorAll('[data-phase="pending"]').length,
				scrollY,
			}));
			assert.ok(result.ready.length > 0);
			assert.ok(
				result.ready.every((value) => value.includes(`Revision C ${outcome}`)),
				`Obsolete revision became ready: ${JSON.stringify(result.ready)}`,
			);
			assert.equal(result.stale, null);
			assert.equal(result.translated, "true");
			assert.equal(result.notes, 1);
			assert.equal(result.pending, 0);
			assert.equal(result.scrollY, 0);
			assert.equal(mock.getMaxActiveResponseCount(), 1);
			if (outcome === "success")
				assert.equal(mock.getResponseRequestCount() - before, 2);
			await page.close();
			console.log(
				`Page source A → B → C (${outcome}): only C became ready without scrolling.`,
			);
		}
		await worker.evaluate(() => {
			chrome.runtime.onMessage.removeListener(
				globalThis.__sourceRevisionListener,
			);
			delete globalThis.__sourceRevisionListener;
			delete globalThis.__sourceRevisionMessages;
		});
	} finally {
		await closeExtensionContext(runState);
		await mock.close();
		await server.close();
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
