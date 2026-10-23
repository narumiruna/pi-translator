#!/usr/bin/env node

const assert = require("node:assert/strict");
const { writeFile } = require("node:fs/promises");
const path = require("node:path");

const AxeBuilder = require("@axe-core/playwright").default;
const { createPdfFixture } = require("./lib/pdf-fixture.cjs");

const {
	ROOT_DIR,
	REQUEST_TIMEOUT_MS,
	callBackground,
	closeExtensionContext,
	createMockApiServer,
	createStaticServer,
	getConfig,
	launchExtensionContext,
	saveOptions,
	takeScreenshot,
	waitFor,
} = require("./lib/extension-test-helpers.cjs");

const PDF_PATH = "/test/fixtures/pdf/two-column.pdf";
const ENCRYPTED_PDF_PATH = path.join(
	ROOT_DIR,
	"test/fixtures/pdf/encrypted.pdf",
);
const MALFORMED_PDF_PATH = path.join(
	ROOT_DIR,
	"test/fixtures/pdf/malformed.pdf",
);

async function instrumentReaderCompletion(context) {
	// Exercise the packaged reader at its port boundary without production test hooks.
	await context.addInitScript(() => {
		if (!location.pathname.endsWith("/sidebar/index.html")) return;
		const trace = {
			queuedIds: [],
			translatedIds: [],
			emptyId: "",
			duplicateUpdates: 0,
		};
		window.pdfCompletionTrace = trace;
		const connect = chrome.runtime.connect.bind(chrome.runtime);
		chrome.runtime.connect = (...args) => {
			const port = connect(...args);
			if (port.name !== "vibe-pdf-translation-v1") return port;
			const postMessage = port.postMessage.bind(port);
			port.postMessage = (message) => {
				if (["queue", "retry"].includes(message.type)) {
					trace.queuedIds.push(...message.items.map(({ id }) => id));
				}
				postMessage(message);
			};
			const addListener = port.onMessage.addListener.bind(port.onMessage);
			port.onMessage.addListener = (listener) =>
				addListener((message) => {
					if (message.type !== "translation-update") {
						listener(message);
						return;
					}
					trace.emptyId ||= message.translations[0]?.id || "";
					const update = {
						...message,
						translations: message.translations.map((translation) => ({
							...translation,
							translation:
								translation.id === trace.emptyId ? "" : translation.translation,
						})),
					};
					trace.translatedIds.push(...update.translations.map(({ id }) => id));
					listener(update);
					listener(update);
					trace.duplicateUpdates += 1;
				});
			return port;
		};
	});
}

async function checkPageActivation(reader, pageNumber) {
	await waitFor(
		async () => {
			const label = await reader.locator("#page-status").textContent();
			const canvas = reader.locator(
				`.pdf-page[data-page-number="${pageNumber}"] canvas`,
			);
			const blocks = reader.locator(
				`.translation-page[data-page-number="${pageNumber}"] .translation-block`,
			);
			return (
				label === `Page ${pageNumber} / 6` &&
				(await canvas.count()) === 1 &&
				(await blocks.count()) > 0 &&
				(await reader
					.locator(
						`.translation-page[data-page-number="${pageNumber}"] .translation-block:not([data-state="ready"])`,
					)
					.count()) === 0
			);
		},
		{
			timeoutMs: REQUEST_TIMEOUT_MS,
			timeoutMessage: `PDF page ${pageNumber} did not render and translate.`,
		},
	);
	await waitFor(
		() =>
			reader.evaluate((number) => {
				const pane = document.querySelector("#translation-scroll");
				const destination = pane.querySelector(
					`[data-page-number="${number}"]`,
				);
				return (
					Math.abs(
						destination.getBoundingClientRect().top -
							pane.getBoundingClientRect().top -
							8,
					) < 3
				);
			}, pageNumber),
		{ timeoutMessage: `Translation pane did not follow page ${pageNumber}.` },
	);
}

async function testNavigationAndCancellation(runState, config, mockApiServer) {
	const reader = await runState.context.newPage();
	await reader.emulateMedia({ reducedMotion: "reduce" });
	await reader.goto(
		`chrome-extension://${runState.extensionId}/sidebar/index.html`,
	);
	await waitFor(async () =>
		/Choose the local PDF/.test(
			await reader.locator("#document-status").textContent(),
		),
	);
	assert.equal(
		await reader
			.locator("#source-scroll")
			.evaluate((pane) => getComputedStyle(pane).scrollBehavior),
		"auto",
		"Reduced motion must disable smooth scrolling.",
	);
	const requestsBefore = mockApiServer.getResponseRequestCount();
	const idsBefore = mockApiServer.getResponseItemIds().length;
	await reader.locator("#local-file").setInputFiles({
		name: "navigation.pdf",
		mimeType: "application/pdf",
		buffer: createPdfFixture(),
	});
	await waitFor(
		async () =>
			(await reader
				.locator(
					'.translation-page[data-page-number="1"] .translation-block[data-state="ready"]',
				)
				.count()) > 0,
	);
	const requestCounts = [mockApiServer.getResponseRequestCount()];
	for (const number of [2, 3, 4]) {
		await reader.locator("#next-page").click();
		await checkPageActivation(reader, number);
		await waitFor(
			async () =>
				(await reader
					.locator(
						`.translation-page[data-page-number="${number + 2}"] .translation-block:not([data-state="ready"])`,
					)
					.count()) === 0,
			{ timeoutMessage: "Navigation did not queue the new page window." },
		);
		requestCounts.push(mockApiServer.getResponseRequestCount());
	}
	assert.ok(
		await reader.locator('.pdf-page[data-page-number="6"] canvas').count(),
		"Next must render the new window, not only its label.",
	);
	await reader.locator("#previous-page").click();
	await checkPageActivation(reader, 3);
	assert.ok(
		requestCounts.every(
			(count, index) => index === 0 || count > requestCounts[index - 1],
		),
		"Each Next must queue the newly reached translation window.",
	);
	const blocks = await reader
		.locator(".translation-block")
		.evaluateAll((items) => items.map((item) => item.dataset.blockId));
	const requestedIds = mockApiServer.getResponseItemIds().slice(idsBefore);
	assert.deepEqual(
		[...requestedIds].sort(),
		[...blocks].sort(),
		"Each block must reach the provider once.",
	);
	const completedRequestCount = mockApiServer.getResponseRequestCount();
	await takeScreenshot(
		reader,
		config.artifactsDir,
		"pdf-six-page-navigation.png",
		false,
	);

	// Use ordinary scrolling as well as reduced-motion button navigation.
	await reader.emulateMedia({ reducedMotion: "no-preference" });
	await reader.locator("#source-scroll").evaluate((pane) => {
		const target = pane.querySelector('[data-page-number="5"]');
		pane.scrollTop +=
			target.getBoundingClientRect().top - pane.getBoundingClientRect().top;
	});
	await checkPageActivation(reader, 5);
	assert.equal(
		mockApiServer.getResponseRequestCount(),
		completedRequestCount,
		"Observer activation must not request completed blocks again.",
	);
	assert.ok(completedRequestCount > requestsBefore);

	// Real SSE connections must close for replacement, cancel, and reader disconnect.
	for (const action of ["replacement", "cancel", "disconnect"]) {
		if (action === "disconnect") {
			await reader.reload();
			await waitFor(async () =>
				/Choose the local PDF/.test(
					await reader.locator("#document-status").textContent(),
				),
			);
		}
		mockApiServer.stallNextResponses(1);
		const start = mockApiServer.getRequests().length;
		await reader.locator("#local-file").setInputFiles({
			name: `${action}.pdf`,
			mimeType: "application/pdf",
			buffer: createPdfFixture({ label: action, pageCount: 1 }),
		});
		await waitFor(
			() =>
				mockApiServer
					.getRequests()
					.slice(start)
					.some((request) => request.stalled && request.finishedAt === null),
			{ timeoutMessage: "PDF mock SSE did not stall." },
		);
		if (action === "replacement") {
			await reader.locator("#local-file").setInputFiles({
				name: "replacement-ready.pdf",
				mimeType: "application/pdf",
				buffer: createPdfFixture({
					label: "Replacement ready",
					pageCount: 1,
				}),
			});
			await waitFor(
				async () =>
					(await reader
						.locator('.translation-block[data-state="ready"]')
						.count()) > 0,
				{ timeoutMessage: "Replacement waited for canceled provider work." },
			);
		} else if (action === "cancel") {
			await reader.locator("#cancel-translation").click();
			await waitFor(async () =>
				/cancelled/i.test(
					await reader.locator("#document-status").textContent(),
				),
			);
			const stalledIds = mockApiServer
				.getRequests()
				.slice(start)
				.filter((request) => request.stalled)
				.flatMap((request) => request.itemIds);
			assert.ok(stalledIds.length > 0);
			for (const id of stalledIds) {
				assert.notEqual(
					await reader
						.locator(`[data-block-id="${id}"]`)
						.getAttribute("data-state"),
					"ready",
					"Canceled stalled blocks must not render a late translation.",
				);
			}
		} else {
			await reader.close();
		}
		await waitFor(
			() =>
				mockApiServer
					.getRequests()
					.slice(start)
					.filter((request) => request.stalled)
					.every((request) => request.aborted && request.finishedAt !== null),
			{ timeoutMessage: `PDF ${action} left the SSE transport open.` },
		);
	}
	await writeFile(
		path.join(config.artifactsDir, "pdf-reliability.json"),
		JSON.stringify(
			{
				navigation: {
					pageCount: 6,
					requestCounts,
					blockCount: blocks.length,
					requestedIds,
				},
				requests: mockApiServer.getRequests(),
			},
			null,
			2,
		),
	);
	console.log(
		"PDF six-page activation, unique requests, normal scrolling, and stalled SSE replacement/cancel/disconnect passed.",
	);
}

async function main() {
	const config = getConfig();
	assert.equal(
		config.useMockApi,
		true,
		"PDF E2E must use PLAYWRIGHT_MOCK_API=1.",
	);
	const server = await createStaticServer(ROOT_DIR);
	const mockApiServer = await createMockApiServer();
	config.baseUrl = mockApiServer.baseUrl;
	let runState;

	try {
		runState = await launchExtensionContext(config, [`${server.origin}/*`]);
		await saveOptions(runState.context, runState.extensionId, config, {
			requiredGlobals: true,
		});

		await testNavigationAndCancellation(runState, config, mockApiServer);
		await instrumentReaderCompletion(runState.context);
		const sourcePage = await runState.context.newPage();
		const sourceUrl = `${server.origin}${PDF_PATH}`;
		await sourcePage.goto(sourceUrl, { waitUntil: "domcontentloaded" });
		mockApiServer.setFailOnTextIncludes("multi-column reading order");
		const opened = await callBackground(runState.context, "openPdf", {
			pageUrl: sourceUrl,
		});
		assert.equal(opened.ok, true);

		const reader = await waitFor(
			async () =>
				runState.context
					.pages()
					.find((page) => page.url().includes("/sidebar/index.html")),
			{
				timeoutMs: REQUEST_TIMEOUT_MS,
				timeoutMessage: "PDF reader tab did not open.",
			},
		);
		await reader.waitForLoadState("domcontentloaded");
		if (process.env.PLAYWRIGHT_DEBUG_CONSOLE === "1") {
			reader.on("requestfailed", (request) =>
				console.error(
					"[reader request failed]",
					request.url(),
					request.failure(),
				),
			);
			reader.on("response", (response) => {
				if (!response.ok()) {
					console.error("[reader response]", response.status(), response.url());
				}
			});
		}
		await waitFor(
			async () => {
				const pageCount = await reader.locator(".pdf-page").count();
				if (process.env.PLAYWRIGHT_DEBUG_CONSOLE === "1" && pageCount !== 3) {
					console.error(
						"[reader state]",
						await reader.locator("#document-status").textContent(),
						await reader.locator("#error").textContent(),
					);
				}
				return pageCount === 3;
			},
			{
				timeoutMs: REQUEST_TIMEOUT_MS,
				timeoutMessage: "PDF pages were not analyzed.",
			},
		);
		await waitFor(
			async () =>
				/Page 1 \/ 3/.test(
					(await reader.locator("#page-status").textContent()) || "",
				),
			{ timeoutMessage: "PDF page status did not settle." },
		);
		assert.match(await reader.title(), / — Pi PDF Reader$/u);
		assert.equal(
			await reader.locator(".translation-block:empty").count(),
			0,
			"Translation blocks must render initial content before queue updates.",
		);
		const originalOnlyBlock = reader.locator(
			'.translation-block[data-state="original"]',
		);
		assert.ok(await originalOnlyBlock.count());
		assert.match(
			(await originalOnlyBlock.first().textContent()) || "",
			/kept in the original PDF/i,
		);
		await waitFor(
			async () => (await reader.locator(".pdf-page canvas").count()) > 0,
			{
				timeoutMs: REQUEST_TIMEOUT_MS,
				timeoutMessage: "PDF canvas did not render.",
			},
		);
		assert.ok(await reader.locator(".text-layer span").count());
		await waitFor(
			async () =>
				(await reader
					.locator('.translation-block[data-state="ready"]')
					.count()) > 0,
			{
				timeoutMs: REQUEST_TIMEOUT_MS,
				timeoutMessage: "No progressive PDF translation appeared.",
			},
		);
		await waitFor(
			async () =>
				(await reader
					.locator('.translation-block[data-state="failed"]')
					.count()) > 0,
			{
				timeoutMs: REQUEST_TIMEOUT_MS,
				timeoutMessage: "Expected PDF partial failure was not shown.",
			},
		);
		mockApiServer.setFailOnTextIncludes("");
		await reader.locator("#retry-failed").click();
		await waitFor(
			async () =>
				(await reader
					.locator('.translation-block[data-state="failed"]')
					.count()) === 0,
			{
				timeoutMs: REQUEST_TIMEOUT_MS,
				timeoutMessage: "PDF retry did not recover failed blocks.",
			},
		);

		const blockCount = await reader
			.locator('.translation-block:not([data-state="original"])')
			.count();
		await waitFor(
			async () =>
				(await reader.locator("#document-status").textContent()) ===
				`${blockCount} blocks translated`,
			{
				timeoutMs: REQUEST_TIMEOUT_MS,
				timeoutMessage:
					"Duplicate and empty updates did not complete exactly once per block.",
			},
		);
		const completion = await reader.evaluate(() => window.pdfCompletionTrace);
		assert.equal(new Set(completion.translatedIds).size, blockCount);
		assert.ok(completion.duplicateUpdates > 0);
		assert.equal(
			await reader
				.locator(`[data-block-id="${completion.emptyId}"]`)
				.getAttribute("data-state"),
			"idle",
		);
		assert.equal(
			await reader.locator('.translation-block[data-state="ready"]').count(),
			blockCount - 1,
		);

		await reader
			.locator('.translation-block[data-state="ready"]')
			.first()
			.click();
		await waitFor(
			async () => (await reader.locator(".source-highlight").count()) > 0,
			{ timeoutMessage: "Translated block did not highlight its source." },
		);
		await reader.locator("#copy-page").click();
		await waitFor(
			async () =>
				/Copied page/i.test(
					(await reader.locator("#document-status").textContent()) || "",
				),
			{ timeoutMessage: "Copy page did not complete." },
		);
		let confirmationText = "";
		reader.once("dialog", async (dialog) => {
			confirmationText = dialog.message();
			await dialog.accept();
		});
		await reader.locator("#translate-all").click();
		await waitFor(async () => confirmationText, {
			timeoutMessage: "Complete-document confirmation did not open.",
		});
		assert.match(
			confirmationText,
			/Translate 0 remaining blocks \(0 characters\)/i,
		);
		await reader.locator("#pause-translation").click();
		assert.equal(
			await reader.locator("#pause-translation").textContent(),
			"Resume",
		);
		await reader.locator("#pause-translation").click();
		assert.equal(
			await reader.locator("#pause-translation").textContent(),
			"Pause",
		);

		await reader.locator("#next-page").click();
		await waitFor(
			async () =>
				/Page 2 \/ 3/.test(
					(await reader.locator("#page-status").textContent()) || "",
				),
			{ timeoutMessage: "PDF page navigation did not update." },
		);
		await reader.locator("#previous-page").click();
		await waitFor(
			async () =>
				/Page 1 \/ 3/.test(
					(await reader.locator("#page-status").textContent()) || "",
				),
			{ timeoutMessage: "PDF navigation back did not update." },
		);
		const translatedText = (
			(await reader
				.locator('.translation-block[data-state="ready"]')
				.first()
				.textContent()) || ""
		).trim();
		assert.ok(translatedText.length > 3);
		await reader
			.locator("#translation-search")
			.fill(translatedText.slice(0, 4));
		assert.ok(await reader.locator(".translation-block:not([hidden])").count());
		await reader.locator("#translation-search").fill("");
		await reader.setViewportSize({ height: 900, width: 1440 });
		await takeScreenshot(
			reader,
			config.artifactsDir,
			"pdf-translation-smoke.png",
			false,
		);
		await reader.setViewportSize({ height: 760, width: 390 });
		assert.equal(
			await reader.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
			true,
		);
		const narrowGeometry = await reader.evaluate(() => {
			const sourceScroll = document.querySelector("#source-scroll");
			const page = document.querySelector(".pdf-page:has(canvas)");
			const canvas = page?.querySelector("canvas");
			const textLayer = page?.querySelector(".text-layer");
			const pageRect = page?.getBoundingClientRect();
			const canvasRect = canvas?.getBoundingClientRect();
			const textRect = textLayer?.getBoundingClientRect();
			return {
				canvasHeight: canvasRect?.height || 0,
				canvasWidth: canvasRect?.width || 0,
				pageHeight: pageRect?.height || 0,
				pageWidth: pageRect?.width || 0,
				scrollsInternally: sourceScroll.scrollWidth > sourceScroll.clientWidth,
				textHeight: textRect?.height || 0,
				textWidth: textRect?.width || 0,
			};
		});
		assert.equal(narrowGeometry.scrollsInternally, true);
		assert.ok(
			Math.abs(narrowGeometry.pageWidth - narrowGeometry.canvasWidth) < 1 &&
				Math.abs(narrowGeometry.pageWidth - narrowGeometry.textWidth) < 1 &&
				Math.abs(narrowGeometry.pageHeight - narrowGeometry.canvasHeight) < 1 &&
				Math.abs(narrowGeometry.pageHeight - narrowGeometry.textHeight) < 1,
			`PDF visual layers diverged: ${JSON.stringify(narrowGeometry)}`,
		);
		assert.deepEqual(
			await reader.evaluate(() => window.pdfCompletionTrace.queuedIds),
			completion.queuedIds,
			"Completed blocks, including empty translations, must not be queued again after navigation or resume.",
		);
		await reader.emulateMedia({ reducedMotion: "reduce" });
		await reader.reload({ waitUntil: "domcontentloaded" });
		await waitFor(
			async () =>
				(await reader.locator(".pdf-page").count()) === 3 &&
				(await reader
					.locator('.translation-block[data-state="ready"]')
					.count()) > 0,
			{
				timeoutMs: REQUEST_TIMEOUT_MS,
				timeoutMessage: "PDF reader did not recover after reload.",
			},
		);
		await waitFor(
			async () =>
				(await reader
					.locator('.translation-block[data-state="ready"]')
					.count()) ===
				blockCount - 1,
			{
				timeoutMessage: "Cached translations did not all return after reload.",
			},
		);
		await waitFor(
			async () =>
				(await reader.evaluate(
					() => window.pdfCompletionTrace.translatedIds.length,
				)) > 0,
			{
				timeoutMessage:
					"The uncached empty translation did not return after reload.",
			},
		);
		assert.deepEqual(
			await reader.evaluate(() => window.pdfCompletionTrace.queuedIds),
			[completion.emptyId],
			"Only the empty translation (not persisted in PDF cache) should be queued after reload.",
		);
		const accessibility = await new AxeBuilder({ page: reader }).analyze();
		assert.deepEqual(
			accessibility.violations,
			[],
			`PDF reader accessibility violations: ${accessibility.violations
				.map((violation) => violation.id)
				.join(", ")}`,
		);

		await reader.locator("#local-file").setInputFiles(ENCRYPTED_PDF_PATH);
		await reader.locator("#password-dialog").waitFor({ state: "visible" });
		await reader.locator("#pdf-password").fill("wrong-password");
		await reader.locator("#submit-password").click();
		await reader.locator("#password-dialog").waitFor({ state: "visible" });
		assert.match(
			(await reader.locator("#password-dialog p").textContent()) || "",
			/incorrect/i,
		);
		await reader.locator("#pdf-password").fill("vibe-test");
		await reader.locator("#submit-password").click();
		await waitFor(
			async () =>
				/3 pages ready|blocks translated/i.test(
					(await reader.locator("#document-status").textContent()) || "",
				),
			{
				timeoutMs: REQUEST_TIMEOUT_MS,
				timeoutMessage: "Encrypted local PDF did not open.",
			},
		);
		await waitFor(
			async () =>
				(await reader
					.locator('.translation-block[data-state="ready"]')
					.count()) > 0,
			{
				timeoutMs: REQUEST_TIMEOUT_MS,
				timeoutMessage: "Replacement PDF did not translate.",
			},
		);

		const readableTitle = await reader.locator("#document-title").textContent();
		await reader.locator("#local-file").setInputFiles(MALFORMED_PDF_PATH);
		await waitFor(
			async () =>
				/invalid pdf|invalid structure/i.test(
					(await reader.locator("#error").textContent()) || "",
				),
			{
				timeoutMs: REQUEST_TIMEOUT_MS,
				timeoutMessage: "Malformed PDF did not report an error.",
			},
		);
		assert.equal(
			await reader.locator("#document-title").textContent(),
			readableTitle,
		);
		assert.ok(await reader.locator(".pdf-page canvas").count());

		await reader.locator("#local-file").setInputFiles(ENCRYPTED_PDF_PATH);
		await reader.locator("#password-dialog").waitFor({ state: "visible" });
		await reader.locator("#pdf-password").fill("vibe-test");
		await reader.locator("#pdf-password").press("Escape");
		await waitFor(
			async () =>
				/password/i.test((await reader.locator("#error").textContent()) || ""),
			{
				timeoutMs: REQUEST_TIMEOUT_MS,
				timeoutMessage: "Encrypted PDF cancellation did not settle.",
			},
		);
		assert.equal(
			await reader.locator("#document-title").textContent(),
			readableTitle,
		);

		await reader.locator("#cancel-translation").click();
		await waitFor(
			async () =>
				/cancelled/i.test(
					(await reader.locator("#document-status").textContent()) || "",
				),
			{ timeoutMessage: "PDF session did not cancel." },
		);
		await reader.close();
		await sourcePage.close();
	} finally {
		mockApiServer.setFailOnTextIncludes("");
		await closeExtensionContext(runState);
		await mockApiServer.close();
		await server.close();
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
