#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
	ROOT_DIR,
	callBackground,
	closeExtensionContext,
	createMockApiServer,
	getConfig,
	launchExtensionContext,
	saveOptions,
	waitFor,
} = require("./lib/extension-test-helpers.cjs");

const TARGET_URL = "https://x.com/1Password/status/2113276767582498943";
const SOURCE_IDS = ["main-post", "reply", "current-post", "legacy-post"];

async function inspectSource(source) {
	return source.evaluate((element) => {
		const id = element.getAttribute("data-ot-source-id");
		const notes = id
			? [...document.querySelectorAll(`[data-ot-note-id="${CSS.escape(id)}"]`)]
			: [];
		const ready = notes.filter(
			(note) => note.getAttribute("data-phase") === "ready",
		);
		const nativeSpans = [...element.children].filter(
			(child) =>
				child.tagName === "SPAN" && !child.hasAttribute("data-ot-role"),
		);
		const nativeBottom = nativeSpans.at(-1).getBoundingClientRect().bottom;
		return {
			noteCount: notes.length,
			readyCount: ready.length,
			visible:
				ready.length === 1 &&
				ready[0].getBoundingClientRect().height > 0 &&
				getComputedStyle(ready[0]).display !== "none",
			below:
				ready.length === 1 &&
				ready[0].getBoundingClientRect().top >= nativeBottom - 1,
			mock: ready.length === 1 && ready[0].textContent.includes("[mock:"),
		};
	});
}

async function requireReadyNote(page, id) {
	const source = page.locator(`#${id}`);
	await source.scrollIntoViewIfNeeded();
	const result = await waitFor(
		async () => {
			const state = await inspectSource(source);
			return state.readyCount === 1 ? state : null;
		},
		{
			timeoutMs: 15000,
			timeoutMessage: `X source #${id} did not receive a translation.`,
		},
	);
	assert.deepEqual(result, {
		noteCount: 1,
		readyCount: 1,
		visible: true,
		below: true,
		mock: true,
	});
}

async function main() {
	const config = getConfig();
	assert.equal(
		config.useMockApi,
		true,
		"X E2E requires PLAYWRIGHT_MOCK_API=1.",
	);
	const fixture = await fs.readFile(
		path.join(ROOT_DIR, "test/x-post-page.html"),
		"utf8",
	);
	const mockApi = await createMockApiServer();
	let runState;
	config.apiKey = "mock-api-key";
	config.baseUrl = mockApi.baseUrl;
	config.model = "mock-model";
	config.userDataDir = "";
	try {
		runState = await launchExtensionContext(config, ["https://x.com/*"]);
		assert.equal(runState.isTemporaryUserDataDir, true);
		await saveOptions(runState.context, runState.extensionId, config, {
			runConnectionTest: false,
		});

		for (const width of [1024, 390]) {
			const page = await runState.context.newPage();
			const errors = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page.route(TARGET_URL, (route) =>
				route.fulfill({
					body: fixture,
					contentType: "text/html; charset=utf-8",
				}),
			);
			await page.setViewportSize({ width, height: 900 });
			await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
			const response = await callBackground(runState.context, "translatePage", {
				pageUrl: page.url(),
			});
			assert.equal(response?.ok, true, JSON.stringify(response));

			for (const id of SOURCE_IDS) {
				await requireReadyNote(page, id);
			}

			await page.evaluate(() => {
				const article = document.createElement("article");
				article.innerHTML =
					'<div id="dynamic-reply" data-x-prose dir="auto" class="whitespace-pre-wrap"><span>A newly loaded reply must also receive an inline translation.</span></div>';
				document.querySelector("#replies").append(article);
			});
			await requireReadyNote(page, "dynamic-reply");
			for (const id of [...SOURCE_IDS].reverse()) {
				await requireReadyNote(page, id);
			}

			assert.equal(
				await page
					.locator(
						"[data-x-ui] [data-ot-source-id], [data-x-ui][data-ot-source-id]",
					)
					.count(),
				0,
			);
			assert.equal(
				await page.locator('[data-ot-role="note"]').count(),
				SOURCE_IDS.length + 1,
			);
			assert.deepEqual(errors, []);
			await fs.mkdir(config.artifactsDir, { recursive: true });
			await page.locator("#main-post").scrollIntoViewIfNeeded();
			await page.screenshot({
				path: path.join(config.artifactsDir, `x-post-${width}.png`),
			});
			console.log(
				JSON.stringify({
					width,
					translatedSources: SOURCE_IDS.length + 1,
					errors,
				}),
			);
			await page.close();
		}
	} finally {
		await closeExtensionContext(runState);
		await mockApi.close();
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
