#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
	ROOT_DIR,
	REQUEST_TIMEOUT_MS,
	callBackground,
	closeExtensionContext,
	createMockApiServer,
	getConfig,
	launchExtensionContext,
	saveOptions,
	waitFor,
} = require("./lib/extension-test-helpers.cjs");

const TARGET_URL = "https://github.com/earendil-works/pi/issues/5350";
const INITIAL_IDS = [
	"issue-title",
	"issue-body",
	"comment-one",
	"comment-two",
	"comment-mention",
	"comment-link",
	"comment-list",
	"comment-nested-list",
];
const ALL_IDS = [...INITIAL_IDS, "dynamic-comment", "deep-comment"];

async function hasReadyNote(source) {
	return source.evaluate((element) => {
		const id = element.getAttribute("data-ot-source-id");
		return Boolean(
			id &&
				document.querySelector(
					`[data-ot-note-id="${CSS.escape(id)}"][data-phase="ready"]`,
				),
		);
	});
}

async function waitForReady(page, id) {
	await waitFor(() => hasReadyNote(page.locator(`#${id}`)), {
		timeoutMs: REQUEST_TIMEOUT_MS,
		timeoutMessage: `GitHub prose block #${id} did not translate.`,
	});
}

async function main() {
	const config = getConfig();
	assert.equal(config.useMockApi, true, "Use PLAYWRIGHT_MOCK_API=1.");
	const fixture = await fs.readFile(
		path.join(ROOT_DIR, "test", "github-issue-page.html"),
		"utf8",
	);
	const mockApiServer = await createMockApiServer();
	let runState;
	config.apiKey = "mock-api-key";
	config.baseUrl = mockApiServer.baseUrl;
	config.model = "mock-model";
	config.userDataDir = "";

	try {
		runState = await launchExtensionContext(config, ["https://github.com/*"]);
		assert.equal(runState.isTemporaryUserDataDir, true);
		await saveOptions(runState.context, runState.extensionId, config, {
			runConnectionTest: false,
		});
		const page = await runState.context.newPage();
		let routedDocuments = 0;
		await page.route(TARGET_URL, async (route) => {
			const request = route.request();
			if (
				request.isNavigationRequest() &&
				request.frame() === page.mainFrame()
			) {
				routedDocuments += 1;
				await route.fulfill({
					body: fixture,
					contentType: "text/html; charset=utf-8",
				});
				return;
			}
			await route.continue();
		});
		await page.setViewportSize({ width: 1024, height: 720 });
		await page.goto(TARGET_URL, {
			waitUntil: "domcontentloaded",
			timeout: REQUEST_TIMEOUT_MS,
		});
		assert.equal(page.url(), TARGET_URL);
		assert.equal(routedDocuments, 1);
		const originalCode = await page.locator("code").allTextContents();
		assert.equal(originalCode.length, 3);

		await callBackground(runState.context, "translatePage", {
			pageUrl: TARGET_URL,
		});
		await waitForReady(page, "issue-title");
		assert.equal(await hasReadyNote(page.locator("#deep-comment")), false);
		assert.equal(
			await page.locator("#deep-comment").getAttribute("data-ot-queued"),
			"false",
		);
		for (const id of INITIAL_IDS) {
			await page.locator(`#${id}`).scrollIntoViewIfNeeded();
			await waitForReady(page, id);
		}

		// Add visible prose only after the initial notes render, without restarting translation.
		await page.evaluate(() => {
			const wrapper = document.createElement("div");
			wrapper.className = "shared__KSUE2D major__A5_AyP";
			wrapper.innerHTML =
				'<div class="markdown-body"><p id="dynamic-comment" data-github-prose>A new timeline comment arrived after translation started and should be discovered by the page observer.</p></div>';
			document.querySelector("#deep-comment-wrapper").before(wrapper);
		});
		await page.locator("#dynamic-comment").scrollIntoViewIfNeeded();
		await waitForReady(page, "dynamic-comment");
		await page.locator("#deep-comment").scrollIntoViewIfNeeded();
		await waitForReady(page, "deep-comment");
		for (const id of [...ALL_IDS].reverse()) {
			await page.locator(`#${id}`).scrollIntoViewIfNeeded();
		}
		await page.waitForTimeout(500);

		const analysis = await page.evaluate(() => ({
			prose: Array.from(
				document.querySelectorAll("[data-github-prose]"),
				(source) => {
					const id = source.getAttribute("data-ot-source-id");
					const notes = id
						? Array.from(
								document.querySelectorAll(
									`[data-ot-note-id="${CSS.escape(id)}"]`,
								),
							)
						: [];
					return {
						id: source.id,
						phases: notes.map((note) => note.getAttribute("data-phase")),
					};
				},
			),
			uiSources: document.querySelectorAll(
				"[data-github-ui][data-ot-source-id], [data-github-ui] [data-ot-source-id]",
			).length,
			uiNotes: document.querySelectorAll(
				'[data-github-ui] [data-ot-role="note"]',
			).length,
			pending: document.querySelectorAll(
				'[data-ot-role="note"][data-phase="pending"]',
			).length,
			notes: document.querySelectorAll('[data-ot-role="note"]').length,
		}));
		assert.deepEqual(
			analysis.prose.map(({ id }) => id).sort(),
			[...ALL_IDS].sort(),
		);
		for (const source of analysis.prose) {
			assert.deepEqual(
				source.phases,
				["ready"],
				`Expected exactly one ready note for #${source.id}.`,
			);
		}
		assert.equal(analysis.uiSources, 0);
		assert.equal(analysis.uiNotes, 0);
		assert.equal(analysis.pending, 0);
		assert.equal(analysis.notes, ALL_IDS.length);
		assert.deepEqual(
			await page.locator("[data-github-prose] code").allTextContents(),
			originalCode,
		);
		const responseIds = mockApiServer.getResponseItemIds();
		assert.equal(responseIds.length, ALL_IDS.length);
		assert.equal(
			new Set(responseIds).size,
			ALL_IDS.length,
			"Duplicate mock API item IDs.",
		);
		console.log(JSON.stringify(analysis, null, 2));
	} finally {
		await closeExtensionContext(runState);
		await mockApiServer.close();
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
