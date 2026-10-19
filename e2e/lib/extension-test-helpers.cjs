const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { chromium } = require("playwright");
const { createMockApiServer } = require("./mock-api-server.cjs");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DEFAULT_ENV_PATH = path.join(ROOT_DIR, ".env");
const DEFAULT_ARTIFACTS_DIR = path.join(ROOT_DIR, "e2e-artifacts");
const REQUEST_TIMEOUT_MS = 120000;
const BUILD_DIR = path.join(ROOT_DIR, "dist", "chrome");

function loadDotEnv(filePath) {
	if (!fs.existsSync(filePath)) {
		return;
	}

	const content = fs.readFileSync(filePath, "utf8");

	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();

		if (!trimmed || trimmed.startsWith("#")) {
			continue;
		}

		const separatorIndex = trimmed.indexOf("=");

		if (separatorIndex <= 0) {
			continue;
		}

		const key = trimmed.slice(0, separatorIndex).trim();

		if (!key || process.env[key] !== undefined) {
			continue;
		}

		let value = trimmed.slice(separatorIndex + 1).trim();

		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		process.env[key] = value;
	}
}

function getEnvValue(...keys) {
	for (const key of keys) {
		const value = process.env[key];

		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}

	return "";
}

function getBooleanEnvValue(key, fallback) {
	const value = process.env[key];

	if (value === undefined) {
		return fallback;
	}

	return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function getConfig() {
	loadDotEnv(process.env.PLAYWRIGHT_ENV_FILE || DEFAULT_ENV_PATH);

	const useMockApi = getBooleanEnvValue("PLAYWRIGHT_MOCK_API", false);
	const apiKey =
		getEnvValue("OPENAI_API_KEY") || (useMockApi ? "mock-api-key" : "");
	const model = getEnvValue("OPENAI_MODEL") || (useMockApi ? "mock-model" : "");

	assert.ok(
		apiKey,
		"Missing API key. Set OPENAI_API_KEY in the environment or .env, or set PLAYWRIGHT_MOCK_API=1.",
	);
	assert.ok(
		model,
		"Missing model. Set OPENAI_MODEL in the environment or .env, or set PLAYWRIGHT_MOCK_API=1.",
	);

	const baseUrl = getEnvValue("OPENAI_BASE_URL") || "https://api.openai.com/v1";
	const targetLanguage =
		getEnvValue("TARGET_LANGUAGE") || "Traditional Chinese (Taiwan)";
	const browserChannel =
		getEnvValue("PLAYWRIGHT_BROWSER_CHANNEL") || "chromium";
	const executablePath = getEnvValue("PLAYWRIGHT_CHROME_EXECUTABLE");

	return {
		apiKey,
		model,
		baseUrl,
		useMockApi,
		targetLanguage,
		browserChannel,
		executablePath,
		headless: getBooleanEnvValue("PLAYWRIGHT_HEADLESS", false),
		userDataDir: getEnvValue("PLAYWRIGHT_USER_DATA_DIR"),
		artifactsDir: path.resolve(
			ROOT_DIR,
			getEnvValue("PLAYWRIGHT_ARTIFACTS_DIR") || DEFAULT_ARTIFACTS_DIR,
		),
	};
}

function getContentType(filePath) {
	const extension = path.extname(filePath).toLowerCase();

	switch (extension) {
		case ".html":
			return "text/html; charset=utf-8";
		case ".js":
			return "text/javascript; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".json":
			return "application/json; charset=utf-8";
		case ".pdf":
			return "application/pdf";
		default:
			return "application/octet-stream";
	}
}

async function createStaticServer(rootDir) {
	const server = http.createServer(async (request, response) => {
		const requestPath = new URL(request.url || "/", "http://127.0.0.1")
			.pathname;
		const resolvedPath = path.resolve(rootDir, `.${requestPath}`);

		if (!resolvedPath.startsWith(rootDir)) {
			response.writeHead(403).end("Forbidden");
			return;
		}

		try {
			const stats = await fsp.stat(resolvedPath);

			if (!stats.isFile()) {
				response.writeHead(404).end("Not Found");
				return;
			}

			response.writeHead(200, {
				"Content-Type": getContentType(resolvedPath),
			});
			fs.createReadStream(resolvedPath).pipe(response);
		} catch (_error) {
			response.writeHead(404).end("Not Found");
		}
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});

	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;

	return {
		origin: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}

					resolve();
				});
			}),
	};
}

function getApiPermissionPattern(baseUrl) {
	const url = new URL(baseUrl);
	return `${url.origin}/*`;
}

async function ensureDir(dirPath) {
	await fsp.mkdir(dirPath, { recursive: true });
}

async function hashFile(filePath) {
	const { createHash } = require("node:crypto");
	return createHash("sha256")
		.update(await fsp.readFile(filePath))
		.digest("hex");
}

async function createE2eExtensionDir(userDataDir, permissionPatterns) {
	const extensionDir = path.join(userDataDir, "extension-under-test");
	const sourceManifestPath = path.join(BUILD_DIR, "manifest.json");
	const sourceManifestHash = await hashFile(sourceManifestPath);

	await fsp.rm(extensionDir, { force: true, recursive: true });
	await ensureDir(extensionDir);
	await fsp.cp(BUILD_DIR, extensionDir, {
		recursive: true,
		filter(sourcePath) {
			return !sourcePath.endsWith(".zip");
		},
	});

	const manifestPath = path.join(extensionDir, "manifest.json");
	const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));

	manifest.host_permissions = Array.from(
		new Set([...(manifest.host_permissions || []), ...permissionPatterns]),
	);
	await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
	assert.equal(
		await hashFile(sourceManifestPath),
		sourceManifestHash,
		"E2E setup must not mutate dist/chrome/manifest.json.",
	);

	return extensionDir;
}

async function clearChromiumProfileLocks(userDataDir) {
	const lockNames = [
		"SingletonCookie",
		"SingletonLock",
		"SingletonSocket",
		"DevToolsActivePort",
	];

	for (const name of lockNames) {
		await fsp.rm(path.join(userDataDir, name), {
			force: true,
			recursive: true,
		});
	}
}

function createLaunchOptions(config, forceHeadless, extensionDir = ROOT_DIR) {
	return {
		headless: forceHeadless ?? config.headless,
		channel: config.executablePath ? undefined : config.browserChannel,
		executablePath: config.executablePath || undefined,
		ignoreDefaultArgs: ["--disable-extensions"],
		args: [
			`--disable-extensions-except=${extensionDir}`,
			`--load-extension=${extensionDir}`,
		],
	};
}

async function waitFor(predicate, options = {}) {
	const timeoutMs = options.timeoutMs || 10000;
	const intervalMs = options.intervalMs || 250;
	const timeoutMessage =
		options.timeoutMessage || "Timed out waiting for condition.";
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		const result = await predicate();

		if (result) {
			return result;
		}

		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}

	throw new Error(timeoutMessage);
}

async function getServiceWorker(context) {
	const existingWorker = context.serviceWorkers()[0];

	if (existingWorker) {
		return existingWorker;
	}

	return context.waitForEvent("serviceworker", { timeout: REQUEST_TIMEOUT_MS });
}

async function getOptionsUrl(context, extensionId) {
	const worker = await getServiceWorker(context);
	const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
	const optionsPath = manifest.options_page || manifest.options_ui?.page;
	return `chrome-extension://${extensionId}/${optionsPath}`;
}

async function waitForText(locator, matcher, timeoutMs, label) {
	let lastText = "";

	try {
		return await waitFor(
			async () => {
				const text = ((await locator.textContent()) || "").trim();

				lastText = text;

				if (matcher.test(text)) {
					return text;
				}

				return "";
			},
			{
				timeoutMs,
				timeoutMessage: `${label} did not match ${matcher}`,
			},
		);
	} catch (error) {
		error.message = `${error.message}. Last text: ${lastText || "(empty)"}`;
		throw error;
	}
}

async function takeScreenshot(page, artifactsDir, fileName, fullPage = true) {
	await page.screenshot({
		path: path.join(artifactsDir, fileName),
		fullPage,
	});
}

async function launchExtensionContext(config, originPatterns = []) {
	const userDataDir = config.userDataDir
		? path.resolve(ROOT_DIR, config.userDataDir)
		: await fsp.mkdtemp(path.join(os.tmpdir(), "vibe-translator-e2e-"));
	const permissionPatterns = Array.from(
		new Set([
			getApiPermissionPattern(config.baseUrl),
			...(originPatterns || []),
		]),
	);

	await ensureDir(userDataDir);
	await ensureDir(config.artifactsDir);
	const extensionDir = await createE2eExtensionDir(
		userDataDir,
		permissionPatterns,
	);
	await clearChromiumProfileLocks(userDataDir);

	const context = await chromium.launchPersistentContext(
		userDataDir,
		createLaunchOptions(config, undefined, extensionDir),
	);
	if (process.env.PLAYWRIGHT_DEBUG_CONSOLE === "1") {
		context.on("page", (page) => {
			page.on("console", (message) => console.log("[page]", message.text()));
			page.on("pageerror", (error) => console.error("[page error]", error));
		});
		context.on("serviceworker", (worker) => {
			worker.on("console", (message) =>
				console.log("[worker]", message.text()),
			);
		});
	}

	const runState = {
		context,
		extensionDir,
		userDataDir,
		isTemporaryUserDataDir: !config.userDataDir,
	};
	try {
		const worker = await getServiceWorker(context);
		return { ...runState, extensionId: new URL(worker.url()).hostname };
	} catch (error) {
		await closeExtensionContext(runState);
		throw error;
	}
}

async function saveOptions(context, extensionId, config, options = {}) {
	const page = await context.newPage();
	const optionsUrl = await getOptionsUrl(context, extensionId);

	await page.goto(optionsUrl, { waitUntil: "domcontentloaded" });
	if (options.requiredGlobals) {
		assert.equal(
			await page.locator("#settings-form").count(),
			1,
			"Expected the bundled options entrypoint to mount.",
		);
	}
	await page.evaluate(async (apiKey) => {
		const key = "vibeTranslatorCredentialsV1";
		const stored = await chrome.storage.local.get(key);
		await chrome.storage.local.set({
			[key]: {
				...(stored[key] || {}),
				"openai-compatible": { type: "api_key", key: apiKey },
			},
		});
	}, config.apiKey);
	const provider = page.locator("#provider");
	// Focus first so the picker settles before Playwright replaces its label.
	await provider.click();
	await provider.fill("openai-compatible");
	await page
		.getByRole("option", { name: /^Custom OpenAI-compatible/u })
		.waitFor({ state: "visible" });
	await provider.press("Enter");
	await page.locator("#custom-base-url").fill(config.baseUrl);
	await page.locator("#model").fill(config.model);
	await page.locator("#target-language").fill(config.targetLanguage);
	if (options.youtubeSubtitleDisplayMode) {
		const displayModeInput = page.locator(
			`[name="youtubeSubtitleDisplayMode"][value="${options.youtubeSubtitleDisplayMode}"]`,
		);

		await displayModeInput.check();
		const inputBounds = await displayModeInput.boundingBox();
		const inputAppearance = await displayModeInput.evaluate(
			(element) => getComputedStyle(element).appearance,
		);

		assert.ok(
			inputBounds && inputBounds.width <= 20 && inputBounds.height <= 20,
			"YouTube display mode should use a compact native radio control.",
		);
		assert.notEqual(
			inputAppearance,
			"none",
			"YouTube display mode should preserve the native checked indicator.",
		);
	}
	await page.locator('[data-tab="appearance"]').click();
	await page
		.locator("#selection-panel-position-mode")
		.selectOption(options.selectionPanelPositionMode || "near-selection");

	if (options.appearancePreset) {
		await page
			.locator("#translation-appearance-preset")
			.selectOption(options.appearancePreset);
	}
	for (const [selector, value] of Object.entries(
		options.appearanceValues || {},
	)) {
		const input = page.locator(selector);

		await input.evaluate((element, nextValue) => {
			const property = element.type === "checkbox" ? "checked" : "value";
			const descriptor = Object.getOwnPropertyDescriptor(
				Object.getPrototypeOf(element),
				property,
			);

			if (!descriptor?.set) {
				throw new Error(`Missing native ${property} setter.`);
			}
			if (property === "checked") {
				descriptor.set.call(element, !nextValue);
				element.click();
				return;
			}

			descriptor.set.call(element, String(nextValue));
			element.dispatchEvent(new Event("input", { bubbles: true }));
			element.dispatchEvent(new Event("change", { bubbles: true }));
		}, value);
	}

	await page.locator("#save-button").click();
	await waitForText(
		page.locator("#form-status"),
		/Settings saved/i,
		15000,
		"Save banner",
	);

	if (options.expectPermissionStatus !== false) {
		const permissionStatus = await waitForText(
			page.locator("#permission-status"),
			/Granted for/i,
			15000,
			"Permission status",
		);
		assert.match(permissionStatus, /Granted for/i);
	}

	if (options.runConnectionTest) {
		await page.locator("#test-button").click();

		const testStatus = await waitFor(
			async () => {
				const text = (
					(await page.locator("#test-status").textContent()) || ""
				).trim();

				return /^Sample translation:/i.test(text) || /failed/i.test(text)
					? text
					: "";
			},
			{
				timeoutMs: REQUEST_TIMEOUT_MS,
				timeoutMessage: "Connection test status did not settle.",
			},
		);
		const testDetails = (
			(await page.locator("#test-details").textContent()) || ""
		).trim();
		const formStatus = (
			(await page.locator("#form-status").textContent()) || ""
		).trim();

		assert.match(
			testStatus,
			/^Sample translation:/i,
			`Expected successful connection test. Details: ${testDetails} ${formStatus}`,
		);
		assert.doesNotMatch(testStatus, /\(empty\)/i);
	}

	if (options.screenshotName) {
		await takeScreenshot(page, config.artifactsDir, options.screenshotName);
	}

	await page.close();
}

async function sendExtensionMessage(context, message) {
	const worker = await getServiceWorker(context);
	const extensionId = new URL(worker.url()).hostname;
	const page = await context.newPage();

	try {
		await page.goto(await getOptionsUrl(context, extensionId), {
			waitUntil: "domcontentloaded",
		});
		const response = await page.evaluate(
			(messagePayload) => chrome.runtime.sendMessage(messagePayload),
			message,
		);
		if (!response || typeof response !== "object") {
			throw new Error("Extension command did not return a response.");
		}
		return response;
	} finally {
		await page.close();
	}
}

async function callBackground(context, operation, payload) {
	if (operation === "getMissingGlobals") {
		const response = await sendExtensionMessage(context, {
			type: "get-runtime-health",
		});
		return response?.ok ? [] : ["background"];
	}

	if (operation === "translatePage" || operation === "openPdf") {
		const response = await sendExtensionMessage(context, {
			type:
				operation === "openPdf"
					? "automation-open-pdf"
					: "automation-translate-page",
			payload: { pageUrl: payload?.pageUrl },
		});
		return response;
	}

	const worker = await getServiceWorker(context);
	const result = await worker.evaluate(
		async ({ type, payload: innerPayload }) => {
			const tabs = await chrome.tabs.query({});
			const tabByUrl = innerPayload?.pageUrl
				? tabs.find((candidate) => candidate.url === innerPayload.pageUrl)
				: null;
			const tab =
				tabByUrl ||
				tabs.find(
					(candidate) => candidate.active && candidate.lastFocusedWindow,
				) ||
				tabs.find((candidate) => candidate.active) ||
				null;

			if (!tab?.id) {
				throw new Error("Could not resolve the active tab for smoke testing.");
			}

			if (type === "getMissingContentGlobals") {
				const response = await chrome.tabs.sendMessage(tab.id, {
					type: "get-runtime-health",
				});
				return response?.ok ? [] : ["content"];
			}

			if (type === "reinjectContent") {
				const manifest = chrome.runtime.getManifest();
				const files = manifest.content_scripts?.[0]?.js || [];
				if (files.length !== 1) {
					throw new Error("Expected one generated content bundle.");
				}
				await chrome.scripting.executeScript({
					target: { tabId: tab.id },
					files,
				});
				return { ok: true, tabId: tab.id };
			}

			if (type === "translatePage") {
				throw new Error(
					"translatePage must run through the extension page bridge.",
				);
			}

			if (type === "translateSelection") {
				let frameId = Number.isInteger(innerPayload?.frameId)
					? innerPayload.frameId
					: 0;

				if (innerPayload?.frameUrl) {
					const frameResults = await chrome.scripting.executeScript({
						target: { tabId: tab.id, allFrames: true },
						func: () => location.href,
					});
					const frameResult = frameResults.find(
						(result) => result.result === innerPayload.frameUrl,
					);

					if (!frameResult) {
						throw new Error(
							`Could not resolve frame id for ${innerPayload.frameUrl}`,
						);
					}

					frameId = frameResult.frameId;
				}

				return {
					automationPayload: {
						frameId,
						pageUrl: innerPayload?.pageUrl || tab.url,
						selectionText: innerPayload.selectionText,
					},
					tabId: tab.id,
					frameId,
				};
			}

			throw new Error(`Unsupported background operation: ${type}`);
		},
		{ type: operation, payload },
	);

	if (operation === "translateSelection") {
		const response = await sendExtensionMessage(context, {
			type: "automation-translate-selection",
			payload: result.automationPayload,
		});
		return { ...response, tabId: result.tabId, frameId: result.frameId };
	}

	return result;
}

async function closeExtensionContext(runState) {
	if (runState?.context) {
		await runState.context.close();
	}

	if (runState?.isTemporaryUserDataDir && runState?.userDataDir) {
		await fsp.rm(runState.userDataDir, { force: true, recursive: true });
	}
}

module.exports = {
	ROOT_DIR,
	REQUEST_TIMEOUT_MS,
	callBackground,
	closeExtensionContext,
	createMockApiServer,
	createStaticServer,
	getApiPermissionPattern,
	getConfig,
	getOptionsUrl,
	launchExtensionContext,
	saveOptions,
	takeScreenshot,
	waitFor,
	waitForText,
};
