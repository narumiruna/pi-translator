#!/usr/bin/env node

const assert = require("node:assert/strict");
const {
	ROOT_DIR,
	closeExtensionContext,
	createMockApiServer,
	createStaticServer,
	getConfig,
	getOptionsUrl,
	launchExtensionContext,
	saveOptions,
	waitFor,
} = require("./lib/extension-test-helpers.cjs");

async function main() {
	process.env.PLAYWRIGHT_ENV_FILE = "/dev/null";
	process.env.PLAYWRIGHT_MOCK_API = "1";
	const config = getConfig();
	const server = await createStaticServer(ROOT_DIR);
	const mock = await createMockApiServer();
	Object.assign(config, {
		apiKey: "mock-api-key",
		model: "mock-model",
		baseUrl: mock.baseUrl,
		userDataDir: "",
	});
	let run;
	try {
		run = await launchExtensionContext(config, [`${server.origin}/*`]);
		assert.equal(run.isTemporaryUserDataDir, true);
		await saveOptions(run.context, run.extensionId, config);
		const worker = run.context
			.serviceWorkers()
			.find(
				(candidate) => new URL(candidate.url()).hostname === run.extensionId,
			);
		const openFixture = async (name, full = false) => {
			const page = await run.context.newPage();
			await page.goto(`${server.origin}/test/page-lifecycle.html?case=${name}`);
			await page.evaluate(
				({ name, full }) => {
					for (const [index, source] of [
						...document.querySelectorAll("p"),
					].entries()) {
						if (!full && index > 0) source.remove();
						else source.textContent = `${name}: ${source.textContent}`;
					}
				},
				{ name, full },
			);
			const tabId = await worker.evaluate(
				async (url) =>
					(await chrome.tabs.query({})).find((tab) => tab.url === url).id,
				page.url(),
			);
			return { page, tabId };
		};
		// Dispatch through Chrome's registered Event bindings, not an automation translation message.
		const click = (tabId, kind) =>
			worker.evaluate(
				async ({ tabId, kind }) => {
					const tab = await chrome.tabs.get(tabId);
					if (kind === "toolbar") chrome.action.onClicked.dispatch(tab);
					else
						chrome.contextMenus.onClicked.dispatch(
							{ menuItemId: "translate-page", frameId: 0 },
							tab,
						);
				},
				{ tabId, kind },
			);
		const ready = (page) =>
			waitFor(
				async () =>
					(await page
						.locator('[data-ot-role="note"][data-phase="ready"]')
						.count()) > 0,
			);
		const session = (tabId) =>
			worker.evaluate(async (tabId) => {
				const result = await chrome.scripting.executeScript({
					target: { tabId },
					func: () =>
						chrome.runtime.sendMessage({
							type: "get-page-translation-session",
						}),
				});
				return result[0].result;
			}, tabId);

		for (const kind of ["toolbar", "context-menu"]) {
			for (const outcome of ["completion", "failure"]) {
				const { page, tabId } = await openFixture(`${kind}-${outcome}`);
				await worker.evaluate(() => {
					const original = chrome.tabs.sendMessage.bind(chrome.tabs);
					globalThis.__lifecycleOriginalSend = original;
					globalThis.__lifecycleHeld = false;
					globalThis.__lifecycleReleased = false;
					let intercepted = false;
					chrome.tabs.sendMessage = async (...args) => {
						if (
							!intercepted &&
							args[1]?.type === "start-page-translation-session"
						) {
							intercepted = true;
							const result = await original(...args);
							return new Promise((resolve, reject) => {
								globalThis.__lifecycleRelease = (fail) => {
									globalThis.__lifecycleReleased = true;
									if (fail) reject(new Error("Receiving end does not exist"));
									else resolve(result);
								};
								globalThis.__lifecycleHeld = true;
							});
						}
						return original(...args);
					};
				});
				try {
					await click(tabId, kind);
					await waitFor(() =>
						worker.evaluate(() => globalThis.__lifecycleHeld),
					);
					await click(tabId, kind);
					await ready(page);
					const replacement = await session(tabId);
					assert.equal(replacement.active, true);
					const source = await page
						.locator("[data-ot-source-id]")
						.evaluate((element) => ({
							id: element.getAttribute("data-ot-source-id"),
							text: element.firstChild.textContent,
						}));
					for (const type of [
						"render-page-translation-updates",
						"render-page-placeholders",
						"clear-page-placeholders",
						"clear-pending-translations",
					]) {
						const rejected = await worker.evaluate(
							({ tabId, type, source }) =>
								chrome.tabs.sendMessage(tabId, {
									type,
									payload: {
										sessionId: "retired-session",
										targetLanguage: "French",
										ids: [source.id],
										items: [source],
										translations: [
											{
												id: source.id,
												sourceText: source.text,
												translation: "Obsolete translation",
											},
										],
									},
								}),
							{ tabId, type, source },
						);
						assert.deepEqual(rejected, { ok: false, stale: true });
					}
					await worker.evaluate(
						(fail) => globalThis.__lifecycleRelease(fail),
						outcome === "failure",
					);
					await page.waitForTimeout(250);
					const current = await session(tabId);
					assert.equal(current.sessionId, replacement.sessionId);
					assert.equal(current.active, true);
					assert.notEqual(
						await worker.evaluate(
							(tabId) => chrome.action.getBadgeText({ tabId }),
							tabId,
						),
						"!",
					);
					assert.equal(
						await page
							.locator('[data-ot-role="note"][data-phase="ready"]')
							.count(),
						1,
					);
					console.log(
						`Packaged ${kind}: superseded ${outcome} preserves replacement session.`,
					);
				} finally {
					await worker.evaluate(() => {
						chrome.tabs.sendMessage = globalThis.__lifecycleOriginalSend;
						for (const key of [
							"__lifecycleOriginalSend",
							"__lifecycleRelease",
							"__lifecycleHeld",
							"__lifecycleReleased",
						])
							delete globalThis[key];
					});
					await page.close();
				}
			}
		}

		const administrative = await openFixture("admin-boundary");
		await click(administrative.tabId, "toolbar");
		await ready(administrative.page);
		const activePage = await session(administrative.tabId);
		await worker.evaluate(
			async (tabId) =>
				chrome.contextMenus.onClicked.dispatch(
					{ menuItemId: "translate-selection", selectionText: "", frameId: 0 },
					await chrome.tabs.get(tabId),
				),
			administrative.tabId,
		);
		await administrative.page.waitForTimeout(100);
		assert.equal(
			(await session(administrative.tabId)).sessionId,
			activePage.sessionId,
		);
		assert.equal((await session(administrative.tabId)).active, true);
		const deniedStorage = await worker.evaluate(async (tabId) => {
			const result = await chrome.scripting.executeScript({
				target: { tabId },
				func: async () => {
					const denied = [];
					for (const area of ["local", "sync"]) {
						for (const operation of ["get", "set"]) {
							try {
								await chrome.storage[area][operation](
									operation === "get"
										? "storage-boundary-probe"
										: { "storage-boundary-probe": "synthetic" },
								);
								denied.push(false);
							} catch (_error) {
								denied.push(true);
							}
						}
					}
					return denied;
				},
			});
			return result[0].result;
		}, administrative.tabId);
		assert.deepEqual(
			deniedStorage,
			[true, true, true, true],
			"Content scripts must not read or mutate trusted settings/credentials.",
		);
		const beforeAdmin = mock.getResponseRequestCount();
		const denied = await worker.evaluate(
			async ({ tabId, baseUrl }) => {
				const response = await chrome.scripting.executeScript({
					target: { tabId },
					func: (baseUrl) =>
						chrome.runtime.sendMessage({
							type: "test-connection",
							payload: {
								provider: "openai-compatible",
								model: "mock-model",
								customBaseUrl: baseUrl,
							},
						}),
					args: [baseUrl],
				});
				return response[0].result;
			},
			{ tabId: administrative.tabId, baseUrl: mock.baseUrl },
		);
		assert.equal(denied.ok, false);
		assert.equal(
			denied.error,
			"Provider administration requires an extension page.",
		);
		const optionsPage = await run.context.newPage();
		await optionsPage.goto(await getOptionsUrl(run.context, run.extensionId));
		const missingPermission = await optionsPage.evaluate(() =>
			chrome.runtime.sendMessage({
				type: "test-connection",
				payload: {
					provider: "openai-compatible",
					model: "mock-model",
					customBaseUrl: "https://unapproved.invalid/v1",
				},
			}),
		);
		assert.equal(missingPermission.ok, false);
		assert.match(missingPermission.error, /permission/i);
		assert.equal(mock.getResponseRequestCount(), beforeAdmin);
		await optionsPage.close();
		await administrative.page.close();
		console.log(
			"Packaged admin boundary rejects content senders and unapproved endpoints before translation.",
		);

		for (const teardown of ["reload", "close"]) {
			const { page, tabId } = await openFixture(`abort-${teardown}`);
			const beforeAbort = mock.getAbortedResponseCount();
			mock.stallNextResponses();
			await click(tabId, "toolbar");
			await waitFor(() => mock.getActiveResponseCount() === 1);
			if (teardown === "reload") await page.reload();
			else await page.close();
			await waitFor(() => mock.getAbortedResponseCount() > beforeAbort, {
				timeoutMessage: `${teardown} did not close the active page SSE request.`,
			});
			await waitFor(() => mock.getActiveResponseCount() === 0);
			if (teardown === "reload") {
				await click(tabId, "context-menu");
				await ready(page);
				await page.close();
			}
			console.log(
				`Packaged page ${teardown} closed its stalled SSE transport.`,
			);
		}

		const { page, tabId } = await openFixture("deadline", true);
		const before = mock.getResponseRequestCount();
		const beforeAbort = mock.getAbortedResponseCount();
		mock.stallNextResponses(5);
		const started = Date.now();
		await click(tabId, "toolbar");
		await waitFor(() => mock.getActiveResponseCount() === 5);
		assert.equal(mock.getResponseRequestCount() - before, 5);
		await waitFor(() => mock.getResponseRequestCount() - before === 6, {
			timeoutMs: 150000,
			timeoutMessage:
				"The real two-minute page deadline did not release queue capacity.",
		});
		assert.ok(
			Date.now() - started >= 119000,
			"The ordinary deadline must not use the subtitle's 30-second limit.",
		);
		await ready(page);
		await waitFor(() => mock.getAbortedResponseCount() - beforeAbort === 5);
		await waitFor(() => mock.getActiveResponseCount() === 0);
		assert.equal(mock.getMaxActiveResponseCount(), 5);
		assert.equal(
			await page.locator('[data-ot-role="note"][data-phase="pending"]').count(),
			0,
		);
		assert.equal(
			await page.locator('[data-ot-role="note"][data-phase="ready"]').count(),
			1,
		);
		console.log(
			"Packaged page deadline: five real stalled SSE transports closed after 120 seconds; queued source translated.",
		);
		await page.close();
	} finally {
		await closeExtensionContext(run);
		await mock.close();
		await server.close();
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
