#!/usr/bin/env node

const assert = require("node:assert/strict");

const {
	ROOT_DIR,
	REQUEST_TIMEOUT_MS,
	callBackground,
	closeExtensionContext,
	createMockApiServer,
	createStaticServer,
	getConfig,
	getOptionsUrl,
	launchExtensionContext,
	saveOptions,
	takeScreenshot,
	waitFor,
} = require("./lib/extension-test-helpers.cjs");
const {
	checkNvidiaNewsroomTranslation,
	NVIDIA_NEWSROOM_ORIGIN,
} = require("./lib/nvidia-newsroom-checks.cjs");

const FIXTURE_PATH = "/test/fixture-page.html";
const REINJECTION_FIXTURE_PATH = "/test/reinjection-page.html";
const NESTED_SCROLL_FIXTURE_PATH = "/test/nested-scroll-page.html";
const PARTIAL_FAILURE_FIXTURE_PATH = "/test/partial-failure-page.html";
const SELECTION_FAILURE_FIXTURE_PATH = "/test/selection-failure-page.html";

const CUSTOM_APPEARANCE_VALUES = Object.freeze({
	"#inline-font-family": "inherit",
	"#inline-font-size": 18,
	"#inline-font-weight": 500,
	"#inline-line-height": 1.8,
	"#inline-max-width": 640,
	"#inline-margin-top": 0,
	"#inline-margin-bottom": 0,
	"#inline-padding-vertical": 0,
	"#inline-padding-horizontal": 0,
	"#inline-border-radius": 0,
	"#inline-accent-width": 0,
	"#inline-show-background": false,
	"#inline-show-label": false,
	"#inline-enable-fade": false,
	"#inline-light-background": "#fff4e6",
	"#inline-light-text": "#221100",
	"#inline-light-accent": "#cc5500",
	"#inline-light-label": "#663300",
	"#inline-dark-background": "#101820",
	"#inline-dark-text": "#f8f9fa",
	"#inline-dark-accent": "#66ccff",
	"#inline-dark-label": "#aaddff",
	"#selection-width": 360,
	"#selection-font-size": 16,
	"#selection-line-height": 1.6,
	"#selection-border-radius": 4,
	"#selection-surface-opacity": 90,
	"#selection-light-surface": "#fff4e6",
	"#selection-light-text": "#221100",
	"#selection-light-accent": "#cc5500",
	"#selection-dark-surface": "#101820",
	"#selection-dark-text": "#f8f9fa",
	"#selection-dark-accent": "#66ccff",
});

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function expectContentHealth(context, page) {
	assert.deepEqual(
		await callBackground(context, "getMissingContentGlobals", {
			pageUrl: page.url(),
		}),
		[],
		"Expected the bundled content runtime to report healthy.",
	);
}

async function expectBackgroundHealth(context) {
	assert.deepEqual(
		await callBackground(context, "getMissingGlobals"),
		[],
		"Expected the bundled background runtime to report healthy.",
	);
}

async function expectVisibleText(page, matcher, label) {
	const body = page.locator("body");
	const text = await waitFor(
		async () => {
			const content = (await body.textContent()) || "";
			return matcher.test(content) ? content : "";
		},
		{
			timeoutMs: 10000,
			timeoutMessage: `${label} was not visible on the page.`,
		},
	);

	assert.match(text, matcher);
}

async function expandDisclosure(button, content, label) {
	if ((await button.getAttribute("aria-expanded")) !== "true") {
		await button.click();
	}
	await waitFor(
		async () =>
			(await button.getAttribute("aria-expanded")) === "true" &&
			(await content.isVisible()),
		{ timeoutMessage: `${label} disclosure did not open.` },
	);
}

async function runAppearanceOptionsSmoke(
	context,
	extensionId,
	config,
	artifactsDir,
	serverOrigin,
) {
	const optionsUrl = await getOptionsUrl(context, extensionId);
	const existingTranslationPage = await context.newPage();

	await existingTranslationPage.goto(`${serverOrigin}${FIXTURE_PATH}`, {
		waitUntil: "domcontentloaded",
	});
	await callBackground(context, "translatePage", {
		pageUrl: existingTranslationPage.url(),
	});
	const existingNote = existingTranslationPage
		.locator('[data-ot-role="note"][data-phase="ready"]')
		.first();
	await waitFor(async () => (await existingNote.count()) > 0, {
		timeoutMs: REQUEST_TIMEOUT_MS,
		timeoutMessage: "Default note for appearance timing did not render.",
	});
	assert.equal(
		await existingNote.evaluate(
			(element) => getComputedStyle(element).backgroundColor,
		),
		"rgba(0, 0, 0, 0)",
	);

	const page = await context.newPage();
	await page.goto(optionsUrl, { waitUntil: "domcontentloaded" });
	await page.locator('[data-tab="appearance"]').click();
	await waitFor(
		async () =>
			(await page.locator("#translation-appearance-preset").inputValue()) ===
				"calm-reading" &&
			(await page.locator("#provider-value").inputValue()) ===
				"openai-compatible" &&
			(await page.locator("#custom-base-url").inputValue()) === config.baseUrl,
		{
			timeoutMessage: "Default appearance did not load.",
		},
	);
	assert.match(
		(await page.locator("#save-state").textContent()) || "",
		/No unsaved changes/i,
	);
	assert.equal(
		(await page.locator("#selection-preview-title").textContent()) || "",
		"Translation",
	);
	assert.equal(
		(await page.locator("#selection-preview-language").textContent()) || "",
		config.targetLanguage,
	);
	const unrelatedSettingsBeforeReset = await page.evaluate(() =>
		Object.fromEntries(
			[
				"provider",
				"custom-base-url",
				"model",
				"target-language",
				"system-prompt-template",
				"user-prompt-template",
				"disabled-domains",
			].map((id) => [id, document.getElementById(id)?.value || ""]),
		),
	);

	await page.locator("#translation-appearance-preset").selectOption("minimal");
	await waitFor(
		async () =>
			(await page.locator("#inline-show-background").isChecked()) === false &&
			(await page
				.locator("#reading-preview-translation")
				.evaluate((element) => getComputedStyle(element).backgroundColor)) ===
				"rgba(0, 0, 0, 0)",
		{ timeoutMessage: "Minimal preset did not update the live preview." },
	);
	assert.match(
		(await page.locator("#save-state").textContent()) || "",
		/Unsaved changes/i,
	);
	assert.equal(await page.locator("#inline-accent-width").inputValue(), "1");
	assert.equal(await page.locator("#inline-show-label").isChecked(), false);
	assert.equal(
		await page
			.locator("#reading-preview-translation")
			.evaluate((element) => getComputedStyle(element).backgroundColor),
		"rgba(0, 0, 0, 0)",
	);
	assert.match(
		(await page.locator("#appearance-contrast-status").textContent()) || "",
		/inherit the host page color/i,
	);

	const readingPanel = page.locator('[aria-labelledby="reading-style-title"]');
	const fontSizeInput = page.locator("#inline-font-size");
	await expandDisclosure(
		readingPanel.getByRole("button", { name: "Typography" }),
		fontSizeInput,
		"Typography",
	);
	await fontSizeInput.fill("19");
	assert.equal(
		await page.locator("#translation-appearance-preset").inputValue(),
		"custom",
	);
	const backgroundToggle = page.locator("#inline-show-background");
	await expandDisclosure(
		readingPanel.getByRole("button", { name: "Layout" }),
		backgroundToggle,
		"Layout",
	);
	await backgroundToggle.evaluate((input) => {
		if (!input.checked) {
			input.click();
		}
	});
	await waitFor(async () => backgroundToggle.isChecked(), {
		timeoutMessage: "Background appearance toggle did not settle.",
	});
	const lightBackgroundInput = page.locator("#inline-light-background");
	await expandDisclosure(
		readingPanel.getByRole("button", { name: "Light Colors" }),
		lightBackgroundInput,
		"Light Colors",
	);
	await lightBackgroundInput.fill("#777777");
	await page.locator("#inline-light-text").fill("#777777");
	assert.match(
		(await page.locator("#appearance-contrast-status").textContent()) || "",
		/Below WCAG AA/i,
	);
	await page.locator("#save-button").click();
	await waitFor(
		async () =>
			/Settings saved/i.test(
				(await page.locator("#form-status").textContent()) || "",
			),
		{ timeoutMessage: "Low-contrast appearance should remain saveable." },
	);
	assert.match(
		(await page.locator("#save-state").textContent()) || "",
		/No unsaved changes/i,
	);
	await page.locator('[data-appearance-theme="dark"]').click();
	assert.equal(
		await page
			.locator('[data-appearance-theme="dark"]')
			.getAttribute("aria-checked"),
		"true",
	);

	await page.locator("#reset-appearance-button").click();
	assert.equal(
		await page.locator("#translation-appearance-preset").inputValue(),
		"calm-reading",
	);
	assert.equal(await page.locator("#inline-font-size").inputValue(), "14");
	assert.match(
		(await page.locator("#save-state").textContent()) || "",
		/Unsaved changes/i,
	);
	assert.deepEqual(
		await page.evaluate(() =>
			Object.fromEntries(
				[
					"provider",
					"custom-base-url",
					"model",
					"target-language",
					"system-prompt-template",
					"user-prompt-template",
					"disabled-domains",
				].map((id) => [id, document.getElementById(id)?.value || ""]),
			),
		),
		unrelatedSettingsBeforeReset,
	);
	await page.close();

	await saveOptions(context, extensionId, config, {
		appearanceValues: CUSTOM_APPEARANCE_VALUES,
		runConnectionTest: false,
		screenshotName: "custom-appearance-options.png",
	});

	const persistedPage = await context.newPage();
	await persistedPage.goto(optionsUrl, { waitUntil: "domcontentloaded" });
	await persistedPage.locator('[data-tab="appearance"]').click();
	await waitFor(
		async () =>
			(await persistedPage
				.locator("#translation-appearance-preset")
				.inputValue()) === "custom",
		{
			timeoutMessage: "Custom appearance did not persist after reload.",
		},
	);
	assert.equal(
		await persistedPage.locator("#inline-font-family").inputValue(),
		"inherit",
	);
	assert.equal(
		await persistedPage.locator("#selection-width").inputValue(),
		"360",
	);
	await persistedPage.setViewportSize({ width: 390, height: 844 });
	const mobilePreviewBounds = await persistedPage.evaluate(() => ({
		viewportWidth: innerWidth,
		bounds: [
			"reading-preview",
			"reading-preview-translation",
			"selection-appearance-preview",
		].map((id) => {
			const element = document.getElementById(id);
			const rect = element.getBoundingClientRect();

			return { id, left: rect.left, right: rect.right };
		}),
	}));
	for (const bound of mobilePreviewBounds.bounds) {
		assert.ok(
			bound.left >= 0 && bound.right <= mobilePreviewBounds.viewportWidth,
			`${bound.id} must stay inside the 390px options viewport.`,
		);
	}
	await takeScreenshot(
		persistedPage,
		artifactsDir,
		"custom-appearance-reloaded.png",
	);
	await persistedPage.close();

	assert.equal(
		await existingNote.evaluate(
			(element) => getComputedStyle(element).fontSize,
		),
		"14px",
		"Saving appearance should not proactively restyle existing translations.",
	);
	const retranslation = await callBackground(context, "translatePage", {
		pageUrl: existingTranslationPage.url(),
	});
	assert.equal(
		retranslation.ok,
		true,
		`Retranslation failed: ${retranslation.error || "unknown error"}`,
	);
	await waitFor(
		async () =>
			(await existingNote.evaluate(
				(element) => getComputedStyle(element).fontSize,
			)) === "18px",
		{
			timeoutMs: REQUEST_TIMEOUT_MS,
			timeoutMessage:
				"Retranslation did not apply the latest saved appearance.",
		},
	);
	await existingTranslationPage.close();
}

async function runCustomAppearanceRuntimeSmoke(
	context,
	serverOrigin,
	targetLanguage,
) {
	const page = await context.newPage();

	await page.setViewportSize({ width: 1280, height: 800 });
	await page.emulateMedia({ colorScheme: "light" });
	await page.goto(`${serverOrigin}${FIXTURE_PATH}`, {
		waitUntil: "domcontentloaded",
	});
	await page.evaluate(() => {
		document.documentElement.style.colorScheme = "dark";
		document.body.style.backgroundColor = "#0d1117";
		document.body.style.color = "#f0f6fc";
	});
	await page.bringToFront();
	await callBackground(context, "translatePage", { pageUrl: page.url() });
	const note = page
		.locator('[data-ot-role="note"][data-phase="ready"]')
		.first();

	await waitFor(async () => (await note.count()) > 0, {
		timeoutMs: REQUEST_TIMEOUT_MS,
		timeoutMessage: "Custom inline translation did not render.",
	});
	const lightStyle = await note.evaluate((element) => {
		const style = getComputedStyle(element);
		const label = element.querySelector('[data-ot-role="note-label"]');
		const source = element.parentElement?.hasAttribute("data-ot-source-id")
			? element.parentElement
			: element.previousElementSibling;

		return {
			animationName: style.animationName,
			backgroundColor: style.backgroundColor,
			borderLeftWidth: style.borderLeftWidth,
			borderTopRightRadius: style.borderTopRightRadius,
			color: style.color,
			fontFamily: style.fontFamily,
			fontSize: style.fontSize,
			sourceFontFamily: getComputedStyle(source).fontFamily,
			fontWeight: style.fontWeight,
			lineHeight: style.lineHeight,
			marginBottom: style.marginBottom,
			marginTop: style.marginTop,
			paddingTop: style.paddingTop,
			width: style.width,
			labelDisplay: label ? getComputedStyle(label).display : "missing",
		};
	});

	assert.equal(lightStyle.animationName, "none");
	assert.equal(lightStyle.backgroundColor, "rgba(0, 0, 0, 0)");
	assert.equal(lightStyle.borderLeftWidth, "0px");
	assert.equal(lightStyle.borderTopRightRadius, "0px");
	assert.equal(lightStyle.color, "rgb(240, 246, 252)");
	assert.equal(lightStyle.fontFamily, lightStyle.sourceFontFamily);
	assert.equal(lightStyle.fontSize, "18px");
	assert.equal(lightStyle.fontWeight, "500");
	assert.equal(lightStyle.lineHeight, "32.4px");
	assert.equal(lightStyle.marginTop, "0px");
	assert.equal(lightStyle.marginBottom, "0px");
	assert.equal(lightStyle.paddingTop, "0px");
	assert.equal(lightStyle.width, "640px");
	assert.equal(lightStyle.labelDisplay, "none");

	await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
	assert.deepEqual(
		await note.evaluate((element) => {
			const style = getComputedStyle(element);

			return { backgroundColor: style.backgroundColor, color: style.color };
		}),
		{ backgroundColor: "rgba(0, 0, 0, 0)", color: "rgb(240, 246, 252)" },
	);

	await page.locator("p").nth(1).selectText();
	const selectionText = await page.evaluate(() =>
		String(window.getSelection()?.toString() || ""),
	);
	await callBackground(context, "translateSelection", {
		pageUrl: page.url(),
		selectionText,
	});
	const panel = page.locator('[data-ot-role="selection-panel"]');
	const body = panel.locator('[data-ot-role="selection-panel-body"]');
	await waitFor(
		async () => (await body.getAttribute("data-state")) === "ready",
		{
			timeoutMs: REQUEST_TIMEOUT_MS,
			timeoutMessage: "Custom selection panel did not become ready.",
		},
	);
	const panelStyle = await panel.evaluate((element) => {
		const style = getComputedStyle(element);
		const title = element.querySelector(
			'[data-ot-role="selection-panel-title"]',
		);

		return {
			backgroundColor: style.backgroundColor,
			borderRadius: style.borderRadius,
			fontSize: style.fontSize,
			lineHeight: style.lineHeight,
			titleColor: title ? getComputedStyle(title).color : "",
			width: style.width,
		};
	});

	assert.equal(panelStyle.backgroundColor, "rgba(16, 24, 32, 0.9)");
	assert.equal(panelStyle.borderRadius, "4px");
	assert.equal(panelStyle.fontSize, "16px");
	assert.equal(panelStyle.lineHeight, "25.6px");
	assert.equal(panelStyle.width, "360px");
	assert.equal(panelStyle.titleColor, "rgb(248, 249, 250)");
	assert.match(
		(await panel.textContent()) || "",
		new RegExp(escapeRegExp(targetLanguage)),
	);
	await page.close();
}

async function runPageTranslationSmoke(context, serverOrigin, artifactsDir) {
	const page = await context.newPage();

	await page.emulateMedia({ colorScheme: "light" });
	await page.goto(`${serverOrigin}${FIXTURE_PATH}`, {
		waitUntil: "domcontentloaded",
	});
	await page.evaluate(() => {
		document.documentElement.style.colorScheme = "light";
		document.body.style.backgroundColor = "#ffffff";
		document.body.style.color = "#24292f";
	});
	await page.bringToFront();

	await callBackground(context, "translatePage", { pageUrl: page.url() });

	const firstNote = page
		.locator('[data-ot-role="note"][data-phase="ready"]')
		.first();
	await waitFor(async () => (await firstNote.count()) > 0, {
		timeoutMs: REQUEST_TIMEOUT_MS,
		timeoutMessage: "No completed page translation note appeared.",
	});
	await expectContentHealth(context, page);

	const noteBodyText = await waitFor(
		async () => {
			const text = await firstNote
				.locator('[data-ot-role="note-body"]')
				.textContent();
			return text?.trim() ? text.trim() : "";
		},
		{
			timeoutMs: REQUEST_TIMEOUT_MS,
			timeoutMessage: "Completed translation note stayed empty.",
		},
	);

	assert.ok(
		noteBodyText.length > 0,
		"Expected a non-empty translated note body.",
	);
	const noteAppearance = await firstNote.evaluate((note) => {
		const noteStyle = getComputedStyle(note);
		const body = note.querySelector('[data-ot-role="note-body"]');
		const bodyStyle = body ? getComputedStyle(body) : null;

		return {
			backgroundColor: noteStyle.backgroundColor,
			borderLeftWidth: noteStyle.borderLeftWidth,
			color: noteStyle.color,
			textDecorationLine: bodyStyle?.textDecorationLine || "",
		};
	});

	assert.equal(
		noteAppearance.backgroundColor,
		"rgba(0, 0, 0, 0)",
		"Expected default translations to remain visually lightweight.",
	);
	assert.equal(noteAppearance.borderLeftWidth, "2px");
	assert.equal(noteAppearance.color, "rgb(36, 41, 47)");
	assert.equal(noteAppearance.textDecorationLine, "none");
	assert.equal(
		(
			(await firstNote.locator('[data-ot-role="note-label"]').textContent()) ||
			""
		).trim(),
		"Translation",
		"Expected a clear translation status label.",
	);
	await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
	const darkAppearance = await firstNote.evaluate((note) => {
		const style = getComputedStyle(note);

		return {
			animationName: style.animationName,
			backgroundColor: style.backgroundColor,
			color: style.color,
		};
	});

	assert.equal(darkAppearance.backgroundColor, "rgba(0, 0, 0, 0)");
	assert.equal(darkAppearance.animationName, "none");
	assert.equal(darkAppearance.color, "rgb(36, 41, 47)");
	await expectVisibleText(
		page,
		/This fixture page exists for manual testing\./,
		"Original source paragraph",
	);

	await page.locator("#translation-table").scrollIntoViewIfNeeded();
	await waitFor(
		async () =>
			(await page
				.locator('#translation-table [data-ot-role="note"][data-phase="ready"]')
				.count()) > 0,
		{
			timeoutMs: REQUEST_TIMEOUT_MS,
			timeoutMessage: "No completed table-cell translation note appeared.",
		},
	);
	const tableCellCounts = await page
		.locator("#translation-table")
		.evaluate((table) =>
			Array.from(table.querySelectorAll("tr")).map(
				(row) =>
					Array.from(row.children).filter((child) =>
						/^(td|th)$/i.test(child.tagName),
					).length,
			),
		);
	assert.deepEqual(
		tableCellCounts,
		[2, 2],
		"Expected table translation notes not to add sibling table cells.",
	);

	await takeScreenshot(page, artifactsDir, "page-translation-smoke.png");
	await page.close();
}

async function runContentReinjectionSmoke(
	context,
	serverOrigin,
	mockApiServer,
) {
	const page = await context.newPage();

	await page.goto(`${serverOrigin}${REINJECTION_FIXTURE_PATH}`, {
		waitUntil: "domcontentloaded",
	});
	await callBackground(context, "translatePage", { pageUrl: page.url() });
	await waitFor(
		async () =>
			(await page
				.locator('#initial-source + [data-ot-role="note"][data-phase="ready"]')
				.count()) > 0,
		{
			timeoutMs: REQUEST_TIMEOUT_MS,
			timeoutMessage: "No note appeared before content reinjection.",
		},
	);
	const before = await page.locator('[data-ot-role="note"]').count();
	const requestCountBefore = mockApiServer?.getResponseRequestCount();

	await callBackground(context, "reinjectContent", { pageUrl: page.url() });
	await expectContentHealth(context, page);
	await new Promise((resolve) => setTimeout(resolve, 300));

	assert.equal(
		await page.locator('[data-ot-role="note"]').count(),
		before,
		"Content reinjection duplicated rendered notes.",
	);
	if (mockApiServer) {
		assert.equal(
			mockApiServer.getResponseRequestCount(),
			requestCountBefore,
			"Content reinjection triggered an unexpected API request.",
		);
	}

	await page.locator("#append-source").click();
	await waitFor(
		async () =>
			(await page
				.locator('#late-source + [data-ot-role="note"][data-phase="ready"]')
				.count()) > 0,
		{
			timeoutMs: REQUEST_TIMEOUT_MS,
			timeoutMessage:
				"Content added after reinjection did not continue the active translation session.",
		},
	);
	if (mockApiServer) {
		assert.ok(
			mockApiServer.getResponseRequestCount() > requestCountBefore,
			"Post-reinjection content did not trigger an API request.",
		);
	}
	await page.close();
}

async function runNestedScrollPageTranslationSmoke(
	context,
	serverOrigin,
	mockApiServer,
) {
	const page = await context.newPage();
	const requestOffset = mockApiServer?.getResponseItemIds().length || 0;

	mockApiServer?.setResponseDelayMs(2000);

	try {
		await page.goto(`${serverOrigin}${NESTED_SCROLL_FIXTURE_PATH}`, {
			waitUntil: "domcontentloaded",
		});
		await page.bringToFront();
		await callBackground(context, "translatePage", { pageUrl: page.url() });

		if (mockApiServer) {
			await waitFor(
				async () =>
					mockApiServer.getResponseItemIds().length - requestOffset >= 5,
				{
					timeoutMs: REQUEST_TIMEOUT_MS,
					timeoutMessage:
						"Initial nested-scroll translation workers did not start.",
				},
			);
			const pendingCount = await page
				.locator('[data-ot-role="note"][data-phase="pending"]')
				.count();

			assert.ok(
				pendingCount > 0 && pendingCount <= 5,
				"Expected one pending note per active ordinary worker.",
			);
		} else {
			await waitFor(
				async () =>
					(await page
						.locator(
							'#visible-source + [data-ot-role="note"][data-phase="ready"]',
						)
						.count()) > 0,
				{
					timeoutMs: REQUEST_TIMEOUT_MS,
					timeoutMessage:
						"Visible nested-scroll fixture content did not translate.",
				},
			);
		}

		assert.equal(
			await page
				.locator('#deep-source + [data-ot-role="note"][data-phase="ready"]')
				.count(),
			0,
			"Expected deep nested-scroll content to stay outside the initial translation window.",
		);

		await page.locator("#scroll-region").evaluate((element) => {
			element.scrollTop = element.scrollHeight;
			element.dispatchEvent(new Event("scroll", { bubbles: true }));
		});

		const deepSource = page.locator("#deep-source");
		assert.equal(await deepSource.isVisible(), true);
		assert.match(
			(await deepSource.textContent()) || "",
			/This deeply nested paragraph/,
		);

		if (mockApiServer) {
			const deepSourceId = await waitFor(
				async () => await deepSource.getAttribute("data-ot-source-id"),
				{
					timeoutMs: REQUEST_TIMEOUT_MS,
					timeoutMessage: "The newly visible source did not receive an id.",
				},
			);
			const requestIndex = await waitFor(
				async () => {
					const index = mockApiServer
						.getResponseItemIds()
						.slice(requestOffset)
						.indexOf(deepSourceId);

					return index >= 0 ? index : null;
				},
				{
					timeoutMs: REQUEST_TIMEOUT_MS,
					timeoutMessage:
						"The newly visible source did not enter the API request order.",
				},
			);

			assert.equal(
				requestIndex,
				5,
				"Expected the newly visible source to claim the first available worker.",
			);
			assert.equal(
				await page
					.locator(`[data-ot-note-id="${deepSourceId}"][data-phase="pending"]`)
					.count(),
				1,
				"Expected one pending note without replacing the source text.",
			);
			assert.equal(
				await deepSource.isVisible(),
				true,
				"Expected source text to remain visible beside its pending note.",
			);
			assert.ok(
				(await page
					.locator('[data-ot-role="note"][data-phase="pending"]')
					.count()) <= 5,
				"Expected pending ordinary notes to stay within worker concurrency.",
			);

			await page.locator("#scroll-region").evaluate((element) => {
				const target = element.querySelector("#backlog-source-20");

				element.scrollTop = target.offsetTop - element.offsetTop - 20;
				element.dispatchEvent(new Event("scroll", { bubbles: true }));
			});
			const restoredVisibleIds = await page
				.locator(".backlog-source")
				.evaluateAll((elements) => {
					const container = document.querySelector("#scroll-region");
					const containerRect = container.getBoundingClientRect();

					return elements
						.filter((element) => {
							const rect = element.getBoundingClientRect();

							return (
								rect.bottom >= containerRect.top &&
								rect.top <= containerRect.bottom
							);
						})
						.map((element) => element.getAttribute("data-ot-source-id"))
						.filter(Boolean);
				});

			assert.ok(
				restoredVisibleIds.length > 0,
				"Expected visible work after reversing the scroll.",
			);
			mockApiServer.setResponseDelayMs(0);
			await waitFor(
				async () =>
					await page.evaluate(
						(ids) =>
							ids.every(
								(id) =>
									document
										.querySelector(`[data-ot-source-id="${id}"]`)
										?.getAttribute("data-ot-translated") === "true",
							),
						restoredVisibleIds,
					),
				{
					timeoutMs: 6000,
					timeoutMessage:
						"The restored stationary viewport did not drain to completion.",
				},
			);
		}

		await waitFor(
			async () =>
				(await deepSource.getAttribute("data-ot-translated")) === "true",
			{
				timeoutMs: 6000,
				timeoutMessage:
					"Nested scrolling did not queue the newly visible paragraph.",
			},
		);
		mockApiServer?.setResponseDelayMs(0);

		await page.locator("#scroll-region").evaluate((element) => {
			element.scrollTop = 0;
			element.dispatchEvent(new Event("scroll", { bubbles: true }));
		});
		await page.locator("#scroll-region").evaluate((element) => {
			element.scrollTop = element.scrollHeight;
			element.dispatchEvent(new Event("scroll", { bubbles: true }));
		});
		await new Promise((resolve) => setTimeout(resolve, 300));

		const deepSourceId = await deepSource.getAttribute("data-ot-source-id");
		assert.equal(
			await page.locator(`[data-ot-note-id="${deepSourceId}"]`).count(),
			1,
			"Scrolling away and back duplicated a completed translation note.",
		);
	} finally {
		mockApiServer?.setResponseDelayMs(0);
		await page.close();
	}
}

async function runSelectionTranslationSmoke(
	context,
	serverOrigin,
	targetLanguage,
	artifactsDir,
	mockApiServer,
) {
	const page = await context.newPage();

	await page.goto(`${serverOrigin}${FIXTURE_PATH}`, {
		waitUntil: "domcontentloaded",
	});
	await page.bringToFront();
	await page.locator("p").nth(1).selectText();

	const selectionText = await page.evaluate(() =>
		typeof window.getSelection === "function"
			? String(window.getSelection()?.toString() || "")
			: "",
	);
	assert.ok(
		selectionText.trim(),
		"Expected selected text before triggering selection translation.",
	);

	if (mockApiServer) {
		mockApiServer.setResponseDelayMs(220);
	}
	const translationPromise = callBackground(context, "translateSelection", {
		pageUrl: page.url(),
		selectionText,
	});
	const panel = page.locator('[data-ot-role="selection-panel"]');
	const panelBody = panel.locator('[data-ot-role="selection-panel-body"]');

	await waitFor(async () => (await panel.count()) > 0, {
		timeoutMs: REQUEST_TIMEOUT_MS,
		timeoutMessage: "Selection translation panel did not appear.",
	});
	if (mockApiServer) {
		await waitFor(
			async () => (await panel.getAttribute("data-state")) === "loading",
			{ timeoutMessage: "Selection panel did not expose its loading state." },
		);
	}
	await translationPromise;
	mockApiServer?.setResponseDelayMs(0);

	await waitFor(async () => (await panel.count()) > 0, {
		timeoutMs: REQUEST_TIMEOUT_MS,
		timeoutMessage: "Selection translation panel did not appear.",
	});
	await expectContentHealth(context, page);
	await waitFor(
		async () => {
			const state = await panelBody.getAttribute("data-state");
			return state === "ready";
		},
		{
			timeoutMs: REQUEST_TIMEOUT_MS,
			timeoutMessage: "Selection translation panel never became ready.",
		},
	);

	const panelTitle =
		(await panel
			.locator('[data-ot-role="selection-panel-title"]')
			.textContent()) || "";
	const panelLanguage =
		(await panel
			.locator('[data-ot-role="selection-panel-language"]')
			.textContent()) || "";
	const panelText = ((await panelBody.textContent()) || "").trim();

	assert.equal(panelTitle, "Translation");
	assert.match(panelLanguage, new RegExp(escapeRegExp(targetLanguage)));
	assert.equal(await panel.getAttribute("role"), "region");
	assert.equal(await panelBody.getAttribute("role"), "status");
	assert.ok(
		panelText.length > 0,
		"Expected a non-empty translated selection panel body.",
	);
	assert.equal(
		await panel.evaluate((element) => element.getBoundingClientRect().width),
		280,
	);
	const collapsedWidth = await panel.evaluate(
		(element) => element.getBoundingClientRect().width,
	);
	await panel.evaluate((element) => {
		const body = element.querySelector('[data-ot-role="selection-panel-body"]');
		const expand = element.querySelector(
			'[data-ot-role="selection-panel-expand"]',
		);

		body.textContent = `${body.textContent} `.repeat(5).trim();
		expand.hidden = false;
		expand.parentElement.hidden = false;
		expand.click();
	});
	await waitFor(
		async () => (await panel.getAttribute("data-expanded")) === "true",
		{ timeoutMessage: "Selection panel did not expand." },
	);
	assert.equal(
		await panel.evaluate((element) => element.getBoundingClientRect().width),
		collapsedWidth,
		"Expected expansion to keep a stable panel width.",
	);

	await takeScreenshot(page, artifactsDir, "selection-translation-smoke.png");
	await page.setViewportSize({ width: 320, height: 640 });
	await waitFor(
		async () => {
			const bounds = await panel.evaluate((element) => {
				const rect = element.getBoundingClientRect();
				return { left: rect.left, right: rect.right };
			});
			return bounds.left >= 0 && bounds.right <= 320;
		},
		{ timeoutMessage: "Selection panel overflowed the narrow viewport." },
	);

	await takeScreenshot(
		page,
		artifactsDir,
		"selection-translation-mobile-smoke.png",
	);

	if (mockApiServer) {
		await page.evaluate(() => {
			const paragraph = document.createElement("p");
			paragraph.id = "dismiss-selection-text";
			paragraph.textContent =
				"Dismiss this unique pending translation before it completes.";
			document.body.appendChild(paragraph);
		});
		await page.locator("#dismiss-selection-text").selectText();
		const dismissSelectionText = await page.evaluate(() =>
			String(window.getSelection()?.toString() || ""),
		);
		mockApiServer.setResponseDelayMs(1000);
		const dismissedTranslation = callBackground(context, "translateSelection", {
			pageUrl: page.url(),
			selectionText: dismissSelectionText,
		});
		await waitFor(
			async () => (await panel.getAttribute("data-state")) === "loading",
			{ timeoutMessage: "Dismiss smoke did not enter loading state." },
		);
		await page.keyboard.press("Escape");
		await dismissedTranslation;
		mockApiServer.setResponseDelayMs(0);
		assert.equal(
			await panel.count(),
			0,
			"Expected a dismissed request to stay hidden after completion.",
		);
	}

	await page.close();
}

async function runBottomRightSelectionSmoke(
	context,
	extensionId,
	config,
	serverOrigin,
) {
	await saveOptions(context, extensionId, config, {
		runConnectionTest: false,
		selectionPanelPositionMode: "bottom-right",
	});
	const page = await context.newPage();

	try {
		await page.setViewportSize({ width: 1000, height: 700 });
		await page.goto(`${serverOrigin}${FIXTURE_PATH}`, {
			waitUntil: "domcontentloaded",
		});
		await page.locator("p").first().selectText();
		const selectionText = await page.evaluate(() =>
			String(window.getSelection()?.toString() || ""),
		);

		await callBackground(context, "translateSelection", {
			pageUrl: page.url(),
			selectionText,
		});
		const panel = page.locator('[data-ot-role="selection-panel"]');
		const panelBody = panel.locator('[data-ot-role="selection-panel-body"]');

		await waitFor(
			async () => (await panelBody.getAttribute("data-state")) === "ready",
			{
				timeoutMs: REQUEST_TIMEOUT_MS,
				timeoutMessage: "Bottom-right selection panel did not become ready.",
			},
		);
		const position = await panel.evaluate((element) => {
			const style = getComputedStyle(element);

			return { bottom: style.bottom, right: style.right };
		});

		assert.deepEqual(
			position,
			{ bottom: "16px", right: "16px" },
			"Expected the selection panel to use its bottom-right CSS position.",
		);
	} finally {
		await page.close();
		await saveOptions(context, extensionId, config, {
			runConnectionTest: false,
			selectionPanelPositionMode: "near-selection",
		});
	}
}

async function runIframeSelectionTranslationSmoke(
	context,
	serverOrigin,
	targetLanguage,
	artifactsDir,
	expectCustomAppearance = false,
) {
	const page = await context.newPage();
	const frameUrl = `${serverOrigin}/test/selection-frame.html`;

	await page.goto(`${serverOrigin}${FIXTURE_PATH}`, {
		waitUntil: "domcontentloaded",
	});
	await page.bringToFront();

	const frame = await waitFor(() => page.frame({ url: frameUrl }), {
		timeoutMs: REQUEST_TIMEOUT_MS,
		timeoutMessage: "Selection iframe did not load.",
	});

	await frame.locator("#frame-selection-text").selectText();
	const selectionText = await frame.evaluate(() =>
		typeof window.getSelection === "function"
			? String(window.getSelection()?.toString() || "")
			: "",
	);
	assert.ok(
		selectionText.trim(),
		"Expected selected iframe text before triggering selection translation.",
	);

	const result = await callBackground(context, "translateSelection", {
		frameUrl,
		pageUrl: page.url(),
		selectionText,
	});
	assert.notEqual(result.frameId, 0, "Expected a non-top frame id.");

	const framePanel = frame.locator('[data-ot-role="selection-panel"]');
	const framePanelBody = framePanel.locator(
		'[data-ot-role="selection-panel-body"]',
	);

	await waitFor(async () => (await framePanel.count()) > 0, {
		timeoutMs: REQUEST_TIMEOUT_MS,
		timeoutMessage: "Iframe selection translation panel did not appear.",
	});
	await waitFor(
		async () => {
			const state = await framePanelBody.getAttribute("data-state");
			return state === "ready";
		},
		{
			timeoutMs: REQUEST_TIMEOUT_MS,
			timeoutMessage: "Iframe selection panel never became ready.",
		},
	);

	const framePanelLanguage =
		(await framePanel
			.locator('[data-ot-role="selection-panel-language"]')
			.textContent()) || "";
	const framePanelText = ((await framePanelBody.textContent()) || "").trim();

	assert.match(framePanelLanguage, new RegExp(escapeRegExp(targetLanguage)));
	assert.ok(
		framePanelText.length > 0,
		"Expected a non-empty translated iframe selection panel body.",
	);
	assert.equal(
		await page.locator('[data-ot-role="selection-panel"]').count(),
		0,
		"Expected no selection panel in the top frame for iframe selections.",
	);
	if (expectCustomAppearance) {
		const framePanelStyle = await framePanel.evaluate((element) => {
			const style = getComputedStyle(element);

			return {
				backgroundColor: style.backgroundColor,
				borderRadius: style.borderRadius,
				fontSize: style.fontSize,
				outerWidth: element.getBoundingClientRect().width,
			};
		});

		const frameViewportWidth = await frame.evaluate(() => innerWidth);

		assert.deepEqual(
			{
				backgroundColor: framePanelStyle.backgroundColor,
				borderRadius: framePanelStyle.borderRadius,
				fontSize: framePanelStyle.fontSize,
			},
			{
				backgroundColor: "rgba(255, 244, 230, 0.9)",
				borderRadius: "4px",
				fontSize: "16px",
			},
		);
		assert.ok(
			framePanelStyle.outerWidth <= 360 &&
				framePanelStyle.outerWidth <= frameViewportWidth - 20,
			"Expected the custom iframe panel width to stay viewport-safe.",
		);
	}

	await takeScreenshot(
		page,
		artifactsDir,
		"iframe-selection-translation-smoke.png",
	);
	await page.close();
}

async function runPagePartialFailureSmoke(
	context,
	serverOrigin,
	mockApiServer,
	artifactsDir,
) {
	const page = await context.newPage();

	mockApiServer.setFailOnTextIncludes("Force mock failure chunk");
	try {
		await page.goto(`${serverOrigin}${PARTIAL_FAILURE_FIXTURE_PATH}`, {
			waitUntil: "domcontentloaded",
		});
		await page.bringToFront();

		await callBackground(context, "translatePage", { pageUrl: page.url() });

		await waitFor(
			async () =>
				(await page
					.locator('[data-ot-role="note"][data-phase="ready"]')
					.count()) > 0,
			{
				timeoutMs: REQUEST_TIMEOUT_MS,
				timeoutMessage:
					"No successful translation appeared during partial failure smoke.",
			},
		);
		await expectVisibleText(
			page,
			/Failed to translate 1 page item\. Successful translations were kept\./,
			"Partial failure toast",
		);
		assert.equal(
			await page.locator('[data-ot-role="note"][data-phase="pending"]').count(),
			0,
			"Expected failed page chunks to clear pending placeholders.",
		);
		await takeScreenshot(page, artifactsDir, "partial-failure-smoke.png");
	} finally {
		mockApiServer.setFailOnTextIncludes("");
		await page.close();
	}
}

async function runSelectionFailureSmoke(context, serverOrigin, mockApiServer) {
	const page = await context.newPage();

	mockApiServer.setFailOnTextIncludes("Unique selected text should trigger");
	try {
		await page.goto(`${serverOrigin}${SELECTION_FAILURE_FIXTURE_PATH}`, {
			waitUntil: "domcontentloaded",
		});
		await page.bringToFront();
		await page.locator("#selection-failure-text").selectText();

		const selectionText = await page.evaluate(() =>
			typeof window.getSelection === "function"
				? String(window.getSelection()?.toString() || "")
				: "",
		);
		assert.ok(
			selectionText.trim(),
			"Expected selected text for failure smoke.",
		);

		await callBackground(context, "translateSelection", {
			pageUrl: page.url(),
			selectionText,
		});
		const panel = page.locator('[data-ot-role="selection-panel"]');
		const panelBody = panel.locator('[data-ot-role="selection-panel-body"]');
		const retryButton = panel.locator('[data-ot-role="selection-panel-retry"]');

		assert.equal(await panel.getAttribute("data-state"), "error");
		assert.equal(await panelBody.getAttribute("role"), "alert");
		assert.match(
			(await panelBody.textContent()) || "",
			/Mock translation failure/,
		);
		assert.equal(await retryButton.isVisible(), true);

		mockApiServer.setFailOnTextIncludes("");
		await retryButton.click();
		await waitFor(
			async () => (await panel.getAttribute("data-state")) === "ready",
			{
				timeoutMs: REQUEST_TIMEOUT_MS,
				timeoutMessage: "Selection translation retry did not succeed.",
			},
		);
	} finally {
		mockApiServer.setFailOnTextIncludes("");
		await page.close();
	}
}

async function main() {
	const config = getConfig();
	const server = await createStaticServer(ROOT_DIR);
	const mockApiServer = config.useMockApi ? await createMockApiServer() : null;
	const fixtureOriginPatterns = [`${server.origin}/*`];
	let runState;

	if (mockApiServer) {
		config.baseUrl = mockApiServer.baseUrl;
		fixtureOriginPatterns.push(`${NVIDIA_NEWSROOM_ORIGIN}/*`);
	}

	try {
		runState = await launchExtensionContext(config, fixtureOriginPatterns);
		console.log(`Using fixture server: ${server.origin}`);
		if (mockApiServer) {
			console.log(`Using mock API server: ${mockApiServer.baseUrl}`);
		}
		console.log(`Using Chrome profile: ${runState.userDataDir}`);

		console.log("Checking background health.");
		await expectBackgroundHealth(runState.context);
		console.log("Saving options.");
		await saveOptions(runState.context, runState.extensionId, config, {
			requiredGlobals: true,
			runConnectionTest: true,
			screenshotName: "options-smoke.png",
		});
		console.log("Options smoke passed.");

		await runPageTranslationSmoke(
			runState.context,
			server.origin,
			config.artifactsDir,
		);
		console.log("Page translation smoke passed.");

		await runContentReinjectionSmoke(
			runState.context,
			server.origin,
			mockApiServer,
		);
		console.log("Content reinjection smoke passed.");

		await runNestedScrollPageTranslationSmoke(
			runState.context,
			server.origin,
			mockApiServer,
		);
		console.log("Nested scroll page translation smoke passed.");

		await runSelectionTranslationSmoke(
			runState.context,
			server.origin,
			config.targetLanguage,
			config.artifactsDir,
			mockApiServer,
		);
		console.log("Selection translation smoke passed.");

		await runBottomRightSelectionSmoke(
			runState.context,
			runState.extensionId,
			config,
			server.origin,
		);
		console.log("Bottom-right selection translation smoke passed.");

		await runIframeSelectionTranslationSmoke(
			runState.context,
			server.origin,
			config.targetLanguage,
			config.artifactsDir,
		);
		console.log("Iframe selection translation smoke passed.");

		if (mockApiServer) {
			await checkNvidiaNewsroomTranslation(
				runState.context,
				config.artifactsDir,
			);
			await runPagePartialFailureSmoke(
				runState.context,
				server.origin,
				mockApiServer,
				config.artifactsDir,
			);
			console.log("Partial failure smoke passed.");

			await runSelectionFailureSmoke(
				runState.context,
				server.origin,
				mockApiServer,
			);
			console.log("Selection failure smoke passed.");
		}

		await runAppearanceOptionsSmoke(
			runState.context,
			runState.extensionId,
			config,
			config.artifactsDir,
			server.origin,
		);
		console.log("Custom appearance options smoke passed.");
		await runCustomAppearanceRuntimeSmoke(
			runState.context,
			server.origin,
			config.targetLanguage,
		);
		console.log("Custom appearance runtime smoke passed.");
		await runIframeSelectionTranslationSmoke(
			runState.context,
			server.origin,
			config.targetLanguage,
			config.artifactsDir,
			true,
		);
		console.log("Custom iframe appearance smoke passed.");
	} finally {
		await closeExtensionContext(runState);
		await mockApiServer?.close();
		await server.close();
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
