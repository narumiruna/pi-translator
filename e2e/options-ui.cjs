#!/usr/bin/env node

const assert = require("node:assert/strict");

const AxeBuilder = require("@axe-core/playwright").default;

const {
	closeExtensionContext,
	createMockApiServer,
	getConfig,
	getOptionsUrl,
	launchExtensionContext,
	saveOptions,
	takeScreenshot,
	waitFor,
} = require("./lib/extension-test-helpers.cjs");

async function expectNoSeriousAccessibilityFindings(page) {
	const results = await new AxeBuilder({ page }).analyze();
	const findings = results.violations.filter((violation) =>
		["serious", "critical"].includes(violation.impact),
	);

	assert.deepEqual(
		findings.map(({ id, impact, nodes }) => ({
			id,
			impact,
			targets: nodes.map((node) => node.target),
		})),
		[],
		"Expected no serious or critical accessibility findings.",
	);
}

async function expectAppearanceLimits(page) {
	const { APPEARANCE_LIMITS } = await import("../src/shared/appearance.js");
	const controls = {
		inline: {
			fontSizePx: "inline-font-size",
			lineHeight: "inline-line-height",
			maxWidthPx: "inline-max-width",
			marginTopPx: "inline-margin-top",
			marginBottomPx: "inline-margin-bottom",
			paddingVerticalPx: "inline-padding-vertical",
			paddingHorizontalPx: "inline-padding-horizontal",
			borderRadiusPx: "inline-border-radius",
			accentWidthPx: "inline-accent-width",
		},
		selection: {
			widthPx: "selection-width",
			fontSizePx: "selection-font-size",
			lineHeight: "selection-line-height",
			borderRadiusPx: "selection-border-radius",
			surfaceOpacityPercent: "selection-surface-opacity",
		},
	};
	let controlCount = 0;
	for (const [section, fields] of Object.entries(controls)) {
		assert.deepEqual(
			Object.keys(fields).sort(),
			Object.keys(APPEARANCE_LIMITS[section]).sort(),
		);
		for (const [key, id] of Object.entries(fields)) {
			const input = page.locator(`#${id}`);
			assert.deepEqual(
				[await input.getAttribute("min"), await input.getAttribute("max")],
				APPEARANCE_LIMITS[section][key].map(String),
				`${id} must use the shared bounds.`,
			);
			assert.equal(
				await input.getAttribute("step"),
				key === "lineHeight" ? "0.01" : "1",
			);
			controlCount += 1;
		}
	}
	assert.equal(
		await page.locator('.appearance-section input[type="number"]').count(),
		controlCount,
	);
}

async function expectSaveActionsInViewport(page) {
	const actions = await page
		.locator(".save-bar-actions button")
		.evaluateAll((buttons) =>
			buttons.map((button) => {
				const rect = button.getBoundingClientRect();
				const hit = document.elementFromPoint(
					rect.x + rect.width / 2,
					rect.y + rect.height / 2,
				);
				return {
					id: button.id,
					inViewport:
						rect.top >= -1 &&
						rect.bottom <= innerHeight + 1 &&
						rect.left >= -1 &&
						rect.right <= innerWidth + 1,
					unobscured: button.contains(hit),
				};
			}),
		);
	for (const action of actions) {
		assert.ok(
			action.inViewport && action.unobscured,
			`Save action is obscured: ${JSON.stringify(action)}`,
		);
	}
}

async function expectResponsiveLayout(page, width, height) {
	await page.setViewportSize({ height, width });
	await page.waitForTimeout(100);
	const bounds = await page.evaluate(() => ({
		clientWidth: document.documentElement.clientWidth,
		scrollWidth: document.documentElement.scrollWidth,
	}));

	assert.ok(
		bounds.scrollWidth <= bounds.clientWidth,
		`Options overflowed horizontally at ${width}px: ${JSON.stringify(bounds)}`,
	);
	for (const fraction of [0, 0.5, 1]) {
		await page.evaluate(
			(position) =>
				window.scrollTo(
					0,
					(document.documentElement.scrollHeight - innerHeight) * position,
				),
			fraction,
		);
		await expectSaveActionsInViewport(page);
	}
	const previews = await page
		.locator("#reading-preview:visible, #selection-appearance-preview:visible")
		.evaluateAll((elements) =>
			elements.map((element) => {
				const rect = element.getBoundingClientRect();
				const parent = element.parentElement.getBoundingClientRect();
				return {
					id: element.id,
					fits:
						rect.left >= parent.left &&
						rect.right <= parent.right &&
						element.scrollWidth <= element.clientWidth,
				};
			}),
		);
	for (const preview of previews) {
		assert.ok(preview.fits, `Preview is clipped at ${width}px: ${preview.id}`);
	}
}

async function expectFocusedField(page, tab, id) {
	await waitFor(
		async () =>
			(await tab.getAttribute("aria-selected")) === "true" &&
			(await page
				.locator(`#${id}`)
				.evaluate((element) => document.activeElement === element)),
		{
			timeoutMessage: `Validation did not reveal and focus ${id}.`,
		},
	);
	assert.equal(await page.locator(`#${id}`).isVisible(), true);
}

async function takeOptionsScreenshot(page, artifactsDir, fileName) {
	await page.mouse.move(0, 0);
	await page.waitForTimeout(220);
	await takeScreenshot(page, artifactsDir, fileName, false);
}

async function waitForStatus(page, matcher, message) {
	return waitFor(
		async () => {
			const text = (await page.locator("#test-status").textContent()) || "";
			return matcher.test(text) ? text : "";
		},
		{ timeoutMessage: message },
	);
}

async function waitForTestReady(page) {
	await waitFor(async () => page.locator("#test-button").isEnabled(), {
		timeoutMessage: "Connection-test action did not become available.",
	});
}

async function expectModalKeyboard(page, dialog) {
	const prompt = dialog.locator("#auth-prompt-value");
	await prompt.waitFor({ state: "visible" });
	await page.waitForTimeout(100);
	assert.equal(
		await prompt.evaluate((element) => document.activeElement === element),
		true,
		"Authentication prompt must receive initial focus.",
	);
	for (const key of ["Tab", "Shift+Tab"]) {
		for (let index = 0; index < 6; index += 1) {
			await page.keyboard.press(key);
			assert.equal(
				await dialog.evaluate((element) =>
					element.contains(document.activeElement),
				),
				true,
				`${key} escaped the authentication dialog.`,
			);
		}
	}
	await page.locator("#target-language").evaluate((element) => element.focus());
	assert.equal(
		await dialog.evaluate((element) =>
			element.contains(document.activeElement),
		),
		true,
		"Background controls must not accept focus.",
	);
	assert.equal(
		await page
			.locator("#save-button")
			.evaluate((element) =>
				Boolean(element.closest('[aria-hidden="true"], [inert]')),
			),
		true,
		"Background controls must be isolated from assistive technology.",
	);
	assert.equal(
		await page.locator("#save-button").evaluate((element) => {
			const rect = element.getBoundingClientRect();
			return element.contains(
				document.elementFromPoint(
					rect.x + rect.width / 2,
					rect.y + rect.height / 2,
				),
			);
		}),
		false,
		"Background controls must not receive pointer input.",
	);
	assert.equal(
		await dialog.evaluate((element) => {
			const rect = element.getBoundingClientRect();
			return (
				rect.left >= 0 &&
				rect.right <= innerWidth &&
				rect.top >= 0 &&
				rect.bottom <= innerHeight
			);
		}),
		true,
		"Authentication dialog must fit in the viewport.",
	);
	assert.equal(
		await dialog.evaluate((element) => getComputedStyle(element).animationName),
		"none",
	);
}

async function expectQuotaRegression(page) {
	const { STORAGE_KEY, validateSettings } = await import(
		"../src/shared/settings.js"
	);
	const original = await page.evaluate(
		async () => (await chrome.storage.sync.get("settings")).settings,
	);
	const makeSettings = (bytes, text) => {
		const settings = validateSettings(original).settings;
		const remaining =
			bytes - Buffer.byteLength(STORAGE_KEY + JSON.stringify(settings));
		const count = Math.floor(remaining / Buffer.byteLength(text));
		settings.systemPromptTemplate +=
			text.repeat(count) +
			"x".repeat(remaining - count * Buffer.byteLength(text));
		assert.equal(
			Buffer.byteLength(STORAGE_KEY + JSON.stringify(settings)),
			bytes,
		);
		return settings;
	};
	try {
		for (const text of ["x", "漢", "🙂"]) {
			const boundary = makeSettings(8192, text);
			const actual = await page.evaluate(async (settings) => {
				await chrome.storage.sync.set({ settings });
				const bytes = await chrome.storage.sync.getBytesInUse("settings");
				try {
					await chrome.storage.sync.set({
						settings: {
							...settings,
							systemPromptTemplate: `${settings.systemPromptTemplate}x`,
						},
					});
					return { bytes, error: "" };
				} catch (error) {
					return { bytes, error: error.message };
				}
			}, boundary);
			assert.equal(actual.bytes, 8192);
			assert.match(actual.error, /QUOTA_BYTES_PER_ITEM|kQuotaBytesPerItem/u);
		}
		await page.evaluate(
			async (settings) => chrome.storage.sync.set({ settings }),
			original,
		);
		await page.reload({ waitUntil: "domcontentloaded" });
		await waitForTestReady(page);
		await page.evaluate(() => {
			const set = chrome.storage.sync.set.bind(chrome.storage.sync);
			window.optionsStorageWrites = 0;
			chrome.storage.sync.set = (...args) => {
				window.optionsStorageWrites += 1;
				return set(...args);
			};
		});
		await page.getByRole("tab", { name: "Prompts" }).click();
		for (const bytes of [8193, 9412]) {
			const oversized = makeSettings(bytes, "漢");
			await page
				.locator("#system-prompt-template")
				.fill(oversized.systemPromptTemplate);
			await page.locator("#save-button").click();
			await waitFor(
				async () => !(await page.locator("#save-button").isDisabled()),
				{ timeoutMessage: "Quota save did not settle." },
			);
			assert.match(
				await page.locator("#form-status").textContent(),
				new RegExp(`${bytes}.*8192`, "u"),
			);
			assert.match(
				await page.locator("#form-status").textContent(),
				/Shorten.*prompt.*domain/u,
			);
			assert.equal(
				await page.locator("#system-prompt-template").inputValue(),
				oversized.systemPromptTemplate,
			);
			assert.deepEqual(
				await page.evaluate(
					async () => (await chrome.storage.sync.get("settings")).settings,
				),
				original,
			);
			assert.equal(
				await page.evaluate(() => window.optionsStorageWrites),
				0,
				"Oversized settings must be rejected before the storage write.",
			);
			assert.match(
				await page.locator("#save-state").textContent(),
				/Unsaved changes/u,
			);
		}
		const boundary = makeSettings(8192, "🙂");
		await page
			.locator("#system-prompt-template")
			.fill(boundary.systemPromptTemplate);
		await page.locator("#save-button").click();
		await waitFor(
			async () =>
				/Settings saved/u.test(
					await page.locator("#form-status").textContent(),
				),
			{ timeoutMessage: "Boundary settings were not saved." },
		);
		assert.equal(
			await page.evaluate(async () =>
				chrome.storage.sync.getBytesInUse("settings"),
			),
			8192,
		);
		await page.evaluate(() => {
			const set = chrome.storage.sync.set.bind(chrome.storage.sync);
			// Force a native Chrome storage rejection for an otherwise valid draft.
			// The rejected probe item is never stored.
			chrome.storage.sync.set = () =>
				set({ "options-storage-failure-probe": "x".repeat(8193) });
		});
		await page
			.locator("#system-prompt-template")
			.fill(original.systemPromptTemplate);
		await page.locator("#save-button").click();
		await waitFor(
			async () => !(await page.locator("#save-button").isDisabled()),
			{ timeoutMessage: "Storage failure did not settle." },
		);
		assert.match(
			await page.locator("#form-status").textContent(),
			/Settings could not be saved.*(?:QUOTA_BYTES_PER_ITEM|kQuotaBytesPerItem)/u,
		);
		assert.doesNotMatch(
			await page.locator("#form-status").textContent(),
			/Check permissions/u,
		);
		assert.equal(
			await page.locator("#system-prompt-template").inputValue(),
			original.systemPromptTemplate,
		);
		assert.deepEqual(
			await page.evaluate(
				async () => (await chrome.storage.sync.get("settings")).settings,
			),
			boundary,
		);
		assert.match(
			await page.locator("#save-state").textContent(),
			/Unsaved changes/u,
		);
		assert.deepEqual(
			await page.evaluate(async () =>
				chrome.storage.sync.get("options-storage-failure-probe"),
			),
			{},
		);
		console.log(
			"Options quota regression passed: Chrome accepts 8192 UTF-8 bytes and rejects 8193 for ASCII, CJK, and emoji; oversized drafts and storage failures preserve settings.",
		);
	} finally {
		// Reload removes the test-only storage wrapper before restoring the fixture.
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.evaluate(
			async (settings) => chrome.storage.sync.set({ settings }),
			original,
		);
	}
}

async function expectAuthenticationRegression(context, optionsUrl, config) {
	const page = await context.newPage();
	try {
		// Synthetic account events exercise the real Options UI without opening a provider or signing in.
		await page.addInitScript(() => {
			// The synthetic port does not need provider setup access.
			chrome.permissions.request = async () => true;
			const connect = chrome.runtime.connect.bind(chrome.runtime);
			chrome.runtime.connect = (options) => {
				if (options.name !== "vibe-translator-auth") return connect(options);
				let listener;
				let requestId;
				window.emitOptionsAuth = (message) =>
					listener?.({ requestId, ...message });
				return {
					onMessage: {
						addListener: (callback) => {
							listener = callback;
						},
					},
					onDisconnect: { addListener: () => {} },
					postMessage(message) {
						if (message.type === "login") {
							requestId = message.requestId;
							queueMicrotask(() =>
								window.emitOptionsAuth({
									type: "prompt",
									promptId: "synthetic-prompt",
									prompt: {
										type: "secret",
										message: "Synthetic account verification code",
									},
								}),
							);
						}
						if (message.type === "cancel") {
							window.optionsAuthCancelled = true;
							queueMicrotask(() =>
								window.emitOptionsAuth({
									type: "result",
									ok: false,
									error: "Authentication cancelled.",
								}),
							);
						}
					},
				};
			};
		});
		await page.goto(optionsUrl, { waitUntil: "domcontentloaded" });
		await waitForTestReady(page);
		await page.locator("#provider").click();
		await page.locator("#provider").fill("openrouter");
		await page.getByRole("option", { name: /^OpenRouter \(/u }).click();
		const trigger = page.getByRole("button", {
			name: "Configure authentication",
		});
		for (const colorScheme of ["light", "dark"]) {
			await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
			await page.setViewportSize({
				width: colorScheme === "dark" ? 320 : 1280,
				height: 900,
			});
			await trigger.click();
			const dialog = page.getByRole("dialog");
			await expectModalKeyboard(page, dialog);
			await expectNoSeriousAccessibilityFindings(page);
			await takeOptionsScreenshot(
				page,
				config.artifactsDir,
				`options-auth-method-${colorScheme}.png`,
			);
			await page.keyboard.press("Escape");
			await dialog.waitFor({ state: "hidden" });
			assert.equal(
				await trigger.evaluate((element) => document.activeElement === element),
				true,
			);
			await trigger.click();
			await dialog.locator("select").selectOption("oauth");
			await dialog.getByRole("button", { name: "Continue" }).click();
			await expectModalKeyboard(page, dialog);
			assert.equal(await dialog.locator("input").inputValue(), "");
			await dialog.locator("input").fill("synthetic-account-code");
			await page.evaluate(() =>
				window.emitOptionsAuth({
					type: "event",
					event: {
						type: "device_code",
						userCode: "SYNTHETIC",
						verificationUri: "https://example.invalid",
					},
				}),
			);
			await dialog.locator("input").waitFor({ state: "hidden" });
			await expectNoSeriousAccessibilityFindings(page);
			await takeOptionsScreenshot(
				page,
				config.artifactsDir,
				`options-auth-account-${colorScheme}.png`,
			);
			if (colorScheme === "dark") {
				await page.keyboard.press("Escape");
			} else {
				await page.evaluate(() =>
					window.emitOptionsAuth({
						type: "event",
						event: {
							type: "auth_url",
							url: "https://example.invalid/login",
							instructions: "Synthetic browser sign-in",
						},
					}),
				);
				await dialog
					.getByText("Synthetic browser sign-in")
					.waitFor({ state: "visible" });
				await dialog.getByRole("button", { name: "Cancel" }).click();
			}
			await dialog.waitFor({ state: "hidden" });
			await waitFor(async () => trigger.isEnabled(), {
				timeoutMessage: "Authentication cancel did not settle.",
			});
			assert.equal(
				await page.evaluate(() => window.optionsAuthCancelled),
				true,
			);
			assert.equal(
				await trigger.evaluate((element) => document.activeElement === element),
				true,
			);
		}
	} finally {
		await page.close();
	}
}

async function main() {
	const config = getConfig();
	assert.equal(
		config.useMockApi,
		true,
		"Options E2E requires the local mock API.",
	);
	assert.equal(
		config.userDataDir,
		"",
		"Options E2E requires a temporary Chrome profile.",
	);
	config.apiKey = "mock-api-key";
	config.model = "mock-model";
	const mockApiServer = await createMockApiServer();
	let runState;

	config.baseUrl = mockApiServer.baseUrl;

	try {
		runState = await launchExtensionContext(config);
		await saveOptions(runState.context, runState.extensionId, config, {
			requiredGlobals: true,
			runConnectionTest: false,
		});

		const optionsUrl = await getOptionsUrl(
			runState.context,
			runState.extensionId,
		);
		const regressions = [];
		const quotaPage = await runState.context.newPage();
		try {
			await quotaPage.goto(optionsUrl, { waitUntil: "domcontentloaded" });
			await waitForTestReady(quotaPage);
			await expectQuotaRegression(quotaPage);
		} catch (error) {
			regressions.push(error);
		} finally {
			await quotaPage.close();
		}
		try {
			await expectAuthenticationRegression(
				runState.context,
				optionsUrl,
				config,
			);
		} catch (error) {
			regressions.push(error);
		}
		assert.deepEqual(
			regressions.map((error) => error.message),
			[],
			"Options quota and keyboard regressions must pass.",
		);

		const page = await runState.context.newPage();
		const pageErrors = [];
		const consoleErrors = [];

		page.on("pageerror", (error) => pageErrors.push(error.message));
		page.on("console", (message) => {
			if (message.type() === "error") {
				consoleErrors.push(message.text());
			}
		});
		await page.goto(
			await getOptionsUrl(runState.context, runState.extensionId),
			{ waitUntil: "domcontentloaded" },
		);
		await waitFor(
			async () =>
				(await page.locator("#provider-value").inputValue()) ===
					"openai-compatible" &&
				(await page.locator("#custom-base-url").inputValue()) ===
					config.baseUrl,
			{ timeoutMessage: "Options settings did not load." },
		);
		assert.equal(await page.locator(".radix-themes").count(), 1);
		assert.match(
			(await page.locator("#permission-status").textContent()) || "",
			/Granted for/u,
		);

		const providerSearch = page.locator("#provider");
		await providerSearch.fill("OpenRouter");
		await waitFor(
			async () =>
				(await page.locator("#provider-options [role='option']").count()) === 1,
			{ timeoutMessage: "Provider search did not filter the custom listbox." },
		);
		assert.match(
			(await page.locator("#provider-options").textContent()) || "",
			/OpenRouter/u,
		);
		await providerSearch.press("Escape");
		assert.match(
			await providerSearch.inputValue(),
			/Custom OpenAI-compatible/u,
		);

		const thinkingLevel = page.getByRole("combobox", {
			name: "Thinking Level",
		});
		assert.equal(await thinkingLevel.inputValue(), "default");
		assert.deepEqual(
			await thinkingLevel
				.locator("option")
				.evaluateAll((options) => options.map((option) => option.value)),
			["default", "off", "minimal", "low", "medium", "high"],
		);
		await thinkingLevel.focus();
		await thinkingLevel.press("End");
		assert.equal(await thinkingLevel.inputValue(), "high");
		assert.match(
			(await page.locator("#save-state").textContent()) || "",
			/Unsaved changes/u,
		);

		await providerSearch.fill("openai");
		await page.getByRole("option", { name: /^OpenAI \(/u }).click();
		const chooseThinkingModel = async (id) => {
			const label = await page
				.locator(`#model-value option[value="${id}"]`)
				.textContent();
			await page.locator("#model").fill(id);
			await page.getByRole("option", { name: label, exact: true }).click();
		};
		await chooseThinkingModel("gpt-5.2");
		assert.equal(await thinkingLevel.inputValue(), "high");
		assert.deepEqual(
			await thinkingLevel
				.locator("option")
				.evaluateAll((options) => options.map((option) => option.value)),
			["default", "off", "low", "medium", "high", "xhigh"],
		);
		await thinkingLevel.selectOption("xhigh");
		await chooseThinkingModel("gpt-5-mini");
		assert.equal(await thinkingLevel.inputValue(), "xhigh");
		assert.equal(
			await thinkingLevel.locator('option[value="xhigh"]').isDisabled(),
			true,
		);
		assert.match(
			(await page.locator("#thinking-level-note").textContent()) || "",
			/Model defaults will be used/u,
		);
		await chooseThinkingModel("gpt-4.1-mini");
		assert.deepEqual(
			await thinkingLevel
				.locator("option:not(:disabled)")
				.evaluateAll((options) => options.map((option) => option.value)),
			["default", "off"],
		);
		await chooseThinkingModel("gpt-5.2");
		assert.equal(await thinkingLevel.inputValue(), "xhigh");
		assert.equal(
			await thinkingLevel.locator('option[value="xhigh"]').isEnabled(),
			true,
		);
		await thinkingLevel.selectOption("default");

		await providerSearch.fill("openrouter");
		await providerSearch.press("Enter");
		await waitFor(
			async () =>
				(await page.locator("#provider-value").inputValue()) === "openrouter" &&
				(await page.locator("#model-value").inputValue()).length > 0,
			{ timeoutMessage: "Searchable provider selection did not load models." },
		);
		const modelSearch = page.locator("#model");
		const modelOptionCount = await page.locator("#model-value option").count();
		await modelSearch.fill("claude");
		await waitFor(
			async () => {
				const matches = await page
					.locator("#model-options [role='option']")
					.count();
				return matches > 0 && matches < modelOptionCount;
			},
			{ timeoutMessage: "Model search did not filter the custom listbox." },
		);
		await modelSearch.press("Escape");

		await page
			.getByRole("button", { name: "Configure authentication" })
			.click();
		const methodDialog = page.getByRole("dialog", {
			name: "Configure OpenRouter",
		});
		assert.deepEqual(
			await methodDialog.locator("select option").allTextContents(),
			["Sign in with an account", "Sign in with an API key"],
		);
		await methodDialog.getByRole("button", { name: "Cancel" }).click();

		await providerSearch.fill("openai-compatible");
		await providerSearch.press("Enter");
		await page.locator("#model").fill(config.model);
		await waitFor(
			async () =>
				/configured with an API key/u.test(
					(await page.locator("#auth-status").textContent()) || "",
				),
			{ timeoutMessage: "Custom provider auth status did not recover." },
		);

		const tabList = page.getByRole("tablist", { name: "Settings sections" });
		const setupTab = page.getByRole("tab", { name: "Setup" });
		const appearanceTab = page.getByRole("tab", { name: "Appearance" });
		const promptsTab = page.getByRole("tab", { name: "Prompts" });
		const advancedTab = page.getByRole("tab", { name: "Advanced" });

		assert.equal(await tabList.count(), 1);
		assert.equal(await page.getByRole("tab").count(), 4);

		assert.match(
			(await page.locator("#auth-status").textContent()) || "",
			/configured with an API key/u,
		);
		assert.equal(await page.locator('input[type="password"]').count(), 0);
		const authTrigger = page.getByRole("button", {
			name: "Change authentication",
		});
		const authDialog = page.getByRole("dialog", {
			name: "Configure Custom OpenAI-compatible",
		});
		for (const colorScheme of ["light", "dark"]) {
			await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
			await page.setViewportSize({
				width: colorScheme === "dark" ? 320 : 1280,
				height: 900,
			});
			await authTrigger.click();
			await expectModalKeyboard(page, authDialog);
			assert.equal(
				await authDialog.locator('input[type="password"]').inputValue(),
				"",
			);
			await authDialog
				.locator('input[type="password"]')
				.fill("replacement-secret");
			await expectNoSeriousAccessibilityFindings(page);
			await takeOptionsScreenshot(
				page,
				config.artifactsDir,
				`options-auth-api-key-${colorScheme}.png`,
			);
			if (colorScheme === "light")
				await authDialog.getByRole("button", { name: "Cancel" }).click();
			else await page.keyboard.press("Escape");
			await authDialog.waitFor({ state: "hidden" });
			await waitFor(async () => authTrigger.isEnabled(), {
				timeoutMessage: "Cancelled authentication did not settle.",
			});
			assert.equal(
				await authTrigger.evaluate(
					(element) => document.activeElement === element,
				),
				true,
			);
		}
		await page.emulateMedia({
			colorScheme: "light",
			reducedMotion: "no-preference",
		});
		await page.setViewportSize({ width: 1280, height: 900 });
		await authTrigger.click();
		await authDialog.locator('input[type="password"]').fill(config.apiKey);
		await authDialog.getByRole("button", { name: "Continue" }).click();
		await authDialog.waitFor({ state: "hidden" });
		await waitFor(async () => authTrigger.isEnabled(), {
			timeoutMessage: "API key authentication did not settle.",
		});
		await authTrigger.click();
		assert.equal(
			await authDialog.locator('input[type="password"]').inputValue(),
			"",
		);
		await page.keyboard.press("Escape");
		await authDialog.waitFor({ state: "hidden" });
		await waitFor(async () => authTrigger.isEnabled(), {
			timeoutMessage: "Reopened API key prompt did not cancel.",
		});
		assert.match(
			(await page.locator("#auth-status").textContent()) || "",
			/configured with an API key/u,
		);
		assert.equal(await page.locator('input[type="password"]').count(), 0);
		assert.match(
			(await page.locator("#save-state").textContent()) || "",
			/No unsaved changes/u,
		);

		await page.locator("#model").fill("");
		await promptsTab.click();
		await page.locator("#save-button").click();
		await expectFocusedField(page, setupTab, "model");
		assert.equal(
			await page.locator("#model").getAttribute("aria-invalid"),
			"true",
		);
		await page.locator("#model").fill(config.model);

		const tabAccessibilityTree = await tabList.ariaSnapshot();
		const setupAccessibilityTree = await page
			.locator('[data-panel="setup"]')
			.ariaSnapshot();
		assert.match(tabAccessibilityTree, /tab "Setup" \[selected\]/u);
		assert.match(setupAccessibilityTree, /Original and translation/u);
		assert.match(setupAccessibilityTree, /Change authentication/u);
		assert.match(setupAccessibilityTree, /Connection Test/u);
		await setupTab.focus();
		await page.keyboard.press("ArrowRight");
		await waitFor(
			async () =>
				(await appearanceTab.getAttribute("aria-selected")) === "true",
			{ timeoutMessage: "Arrow-key tab activation did not settle." },
		);
		assert.equal(
			await page.getByRole("heading", { name: "Appearance" }).isVisible(),
			true,
		);

		await setupTab.click();
		const bilingualRadio = page.getByRole("radio", {
			name: /Original and translation/u,
		});
		const translationOnlyRadio = page.getByRole("radio", {
			name: /Translation only/u,
		});
		await bilingualRadio.focus();
		await page.keyboard.press("Space");
		assert.equal(await bilingualRadio.isChecked(), true);
		await page.keyboard.press("ArrowDown");
		assert.equal(await translationOnlyRadio.isChecked(), true);

		await promptsTab.click();
		const systemPrompt = page.locator("#system-prompt-template");
		const originalPrompt = await systemPrompt.inputValue();
		await systemPrompt.fill(`${originalPrompt}\nKeep this draft.`);
		assert.match(
			(await page.locator("#save-state").textContent()) || "",
			/Unsaved changes/u,
		);
		await setupTab.click();
		await promptsTab.click();
		assert.match(await systemPrompt.inputValue(), /Keep this draft\./u);
		assert.match(
			await page.locator("#system-prompt-preview").inputValue(),
			/Keep this draft\./u,
		);
		await page
			.locator("#user-prompt-template")
			.fill("Return JSON translations in the selected language.");
		assert.match(
			(await page.locator("#prompt-lint-status").textContent()) || "",
			/sourcePayload/u,
		);
		await page.locator("#reset-user-prompt-button").click();
		assert.match(
			await page.locator("#user-prompt-template").inputValue(),
			/\{\{sourcePayload\}\}/u,
		);
		await page.locator("#reset-system-prompt-button").click();
		assert.doesNotMatch(await systemPrompt.inputValue(), /Keep this draft\./u);
		await systemPrompt.fill(
			`${await systemPrompt.inputValue()}\nKeep this draft.`,
		);

		await advancedTab.click();
		await page.locator("#show-translation-debug-info").check();
		await page
			.locator("#disabled-domains")
			.fill(" EXAMPLE.COM, chat.openai.com ");

		await appearanceTab.click();
		await expectAppearanceLimits(page);
		await page
			.locator("#selection-panel-position-mode")
			.selectOption("bottom-right");
		await page.getByRole("button", { name: "Typography" }).click();
		assert.equal(await page.locator("#inline-font-size").isVisible(), true);
		assert.equal(
			await page
				.locator('[data-appearance-theme="light"]')
				.getAttribute("aria-checked"),
			"true",
		);

		await promptsTab.click();
		await page
			.locator("#user-prompt-template")
			.fill("Translate without the required source placeholder.");
		await setupTab.click();
		await bilingualRadio.check();
		await thinkingLevel.selectOption("high");
		await page.locator("#custom-base-url").fill("https://example.com/not-v1");
		await advancedTab.click();
		await page.locator("#save-button").click();
		await expectFocusedField(page, setupTab, "custom-base-url");
		await waitFor(
			async () =>
				/Base URL must include \/v1/u.test(
					(await page.locator("#form-status").textContent()) || "",
				),
			{
				timeoutMessage: "Invalid Base URL did not produce a validation error.",
			},
		);
		assert.equal(
			await page.locator("#custom-base-url").getAttribute("aria-invalid"),
			"true",
		);
		assert.match(
			(await page
				.locator("#custom-base-url")
				.getAttribute("aria-describedby")) || "",
			/form-status/u,
		);
		await promptsTab.click();
		assert.equal(
			await page.locator("#user-prompt-template").getAttribute("aria-invalid"),
			"true",
		);
		await setupTab.click();
		await page.locator("#custom-base-url").fill(config.baseUrl);
		assert.equal(
			await page.locator("#custom-base-url").getAttribute("aria-invalid"),
			null,
		);
		await promptsTab.click();
		assert.equal(
			await page.locator("#user-prompt-template").getAttribute("aria-invalid"),
			"true",
		);
		await setupTab.click();
		await page.locator("#save-button").click();
		await expectFocusedField(page, promptsTab, "user-prompt-template");
		await page.locator("#reset-user-prompt-button").click();
		assert.equal(
			await page.locator("#user-prompt-template").getAttribute("aria-invalid"),
			null,
		);
		await setupTab.click();
		await page.locator("#custom-base-url").blur();
		await waitFor(
			async () =>
				/Granted for/u.test(
					(await page.locator("#permission-status").textContent()) || "",
				),
			{ timeoutMessage: "Permission status did not recover." },
		);

		await page.locator("#save-button").click();
		await waitFor(
			async () =>
				/Settings saved/u.test(
					(await page.locator("#form-status").textContent()) || "",
				),
			{ timeoutMessage: "Settings did not save." },
		);
		assert.match(
			(await page.locator("#save-state").textContent()) || "",
			/No unsaved changes/u,
		);

		await page.reload({ waitUntil: "domcontentloaded" });
		await waitFor(
			async () =>
				(await page.locator("#provider-value").inputValue()) ===
					"openai-compatible" &&
				(await page.locator("#custom-base-url").inputValue()) ===
					config.baseUrl,
			{ timeoutMessage: "Saved settings did not reload." },
		);
		assert.equal(await bilingualRadio.isChecked(), true);
		assert.equal(await thinkingLevel.inputValue(), "high");
		assert.equal(await page.locator('input[type="password"]').count(), 0);
		assert.equal(
			await page.locator("#selection-panel-position-mode").inputValue(),
			"bottom-right",
		);
		assert.equal(
			await page.locator("#show-translation-debug-info").isChecked(),
			true,
		);
		assert.equal(
			await page.locator("#disabled-domains").inputValue(),
			"example.com\nchat.openai.com",
		);
		assert.match(await systemPrompt.inputValue(), /Keep this draft\./u);

		await appearanceTab.click();
		const typography = page.getByRole("button", { name: "Typography" });
		await typography.click();
		await page.locator("#inline-font-size").fill("99");
		await typography.click();
		await setupTab.click();
		await page.locator("#save-button").click();
		await expectFocusedField(page, appearanceTab, "inline-font-size");
		assert.equal(await typography.getAttribute("aria-expanded"), "true");
		await page.locator("#inline-font-size").fill("16");
		await page.locator("#reset-appearance-button").click();
		await typography.click();

		for (const colorScheme of ["light", "dark"]) {
			await page.emulateMedia({ colorScheme });
			for (const tab of [setupTab, appearanceTab, promptsTab, advancedTab]) {
				await tab.click();
				await page.waitForTimeout(200);
				await expectNoSeriousAccessibilityFindings(page);
				await expectResponsiveLayout(page, 320, 720);
				await expectResponsiveLayout(page, 390, 844);
				await expectResponsiveLayout(page, 720, 900);
				await expectResponsiveLayout(page, 1280, 900);
				await page.evaluate(() => window.scrollTo(0, 0));
				await takeOptionsScreenshot(
					page,
					config.artifactsDir,
					`options-${await tab.getAttribute("data-tab")}-${colorScheme}.png`,
				);
			}
		}

		await page.emulateMedia({ colorScheme: "light" });
		await page.reload({ waitUntil: "domcontentloaded" });
		await waitForTestReady(page);
		await page.setViewportSize({ width: 1280, height: 1200 });
		await page.evaluate(() => window.scrollTo(0, 0));
		await takeOptionsScreenshot(
			page,
			config.artifactsDir,
			"radix-options-light.png",
		);
		await appearanceTab.click();
		await page.setViewportSize({ width: 1280, height: 1600 });
		await page.evaluate(() => window.scrollTo(0, 0));
		await takeOptionsScreenshot(
			page,
			config.artifactsDir,
			"radix-options-appearance.png",
		);

		await typography.click();
		await page.locator("#selection-width").fill("480");
		await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
		await expectResponsiveLayout(page, 320, 720);
		assert.equal(
			await page
				.locator("#reading-preview-translation")
				.evaluate((element) => getComputedStyle(element).animationName),
			"none",
		);
		assert.equal(
			await page
				.locator('.appearance-disclosure-content[data-state="open"]')
				.first()
				.evaluate((element) => getComputedStyle(element).animationName),
			"none",
		);
		await page.locator("#reset-appearance-button").click();
		await page.reload({ waitUntil: "domcontentloaded" });
		await waitForTestReady(page);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.evaluate(() => window.scrollTo(0, 0));
		await takeOptionsScreenshot(
			page,
			config.artifactsDir,
			"radix-options-dark-mobile.png",
		);
		await page.emulateMedia({
			forcedColors: "active",
			reducedMotion: "reduce",
		});
		await expectSaveActionsInViewport(page);
		await page.emulateMedia({ colorScheme: "light", forcedColors: "none" });

		await page.setViewportSize({ height: 900, width: 1280 });
		await page.evaluate(() => {
			document.documentElement.style.zoom = "2";
		});
		const zoomBounds = await page.evaluate(() => ({
			clientWidth: document.documentElement.clientWidth,
			scrollWidth: document.documentElement.scrollWidth,
		}));
		assert.ok(zoomBounds.scrollWidth <= zoomBounds.clientWidth);
		await expectSaveActionsInViewport(page);
		await page.evaluate(() => {
			document.documentElement.style.zoom = "";
		});

		await setupTab.click();
		mockApiServer.failNextResponses();
		await page.locator("#test-button").click();
		await waitForStatus(
			page,
			/Connection test failed\./u,
			"Connection failure did not render.",
		);
		assert.match(
			(await page.locator("#form-status").textContent()) || "",
			/Mock translation failure\./u,
		);
		await waitForTestReady(page);
		await page.locator("#test-button").click();
		await waitForStatus(
			page,
			/^Sample translation:/u,
			"Connection retry did not recover.",
		);
		await waitForTestReady(page);

		mockApiServer.setResponseDelayMs(250);
		await page.locator("#model").fill(`${config.model}-pending-edit`);
		await page.locator("#test-button").click();
		await waitForStatus(
			page,
			/Testing connection/u,
			"Delayed connection test did not start.",
		);
		await page.locator("#target-language").fill("日本語");
		await promptsTab.click();
		await setupTab.click();
		await waitForStatus(
			page,
			/^Sample translation:/u,
			"Delayed connection test did not settle.",
		);
		assert.equal(await page.locator("#target-language").inputValue(), "日本語");
		assert.match(
			(await page.locator("#test-details").textContent()) || "",
			/earlier values/u,
		);
		mockApiServer.setResponseDelayMs(0);
		await waitForTestReady(page);

		await page.locator("#model").fill(`${config.model}-duplicate-guard`);
		const requestCountBefore = mockApiServer.getResponseRequestCount();
		await page.locator("#test-button").evaluate((button) => {
			button.click();
			button.click();
		});
		await waitFor(
			async () => mockApiServer.getResponseRequestCount() > requestCountBefore,
			{ timeoutMessage: "Duplicate-guard connection request was not sent." },
		);
		await waitForTestReady(page);
		assert.equal(
			mockApiServer.getResponseRequestCount() - requestCountBefore,
			1,
			"One user operation must send one connection-test request.",
		);

		const performanceMetrics = await page.evaluate(() => {
			const navigation = performance.getEntriesByType("navigation")[0];
			const firstContentfulPaint = performance
				.getEntriesByType("paint")
				.find((entry) => entry.name === "first-contentful-paint");
			return {
				domContentLoadedMs: navigation?.domContentLoadedEventEnd || 0,
				firstContentfulPaintMs: firstContentfulPaint?.startTime || 0,
				remoteResources: performance
					.getEntriesByType("resource")
					.map((entry) => entry.name)
					.filter((url) => !url.startsWith("chrome-extension://")),
			};
		});
		assert.ok(performanceMetrics.domContentLoadedMs <= 500);
		assert.ok(performanceMetrics.firstContentfulPaintMs <= 500);
		assert.deepEqual(performanceMetrics.remoteResources, []);
		assert.deepEqual(pageErrors, []);
		assert.deepEqual(consoleErrors, []);
		assert.doesNotMatch(
			JSON.stringify({ consoleErrors, pageErrors }),
			new RegExp(config.apiKey, "u"),
		);
		await page.close();
		console.log(
			`Radix options UI E2E passed (${JSON.stringify(performanceMetrics)}).`,
		);
	} finally {
		await closeExtensionContext(runState);
		await mockApiServer.close();
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
