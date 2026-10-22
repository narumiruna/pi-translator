import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

function event() {
	return { addListener: vi.fn() };
}

async function loadEntry(options = {}) {
	vi.resetModules();
	const controller = {
		translatePage: vi.fn(),
		translateSelection: vi.fn(),
		removePageTranslationState: vi.fn(),
		setupContextMenus: vi.fn(async () => {}),
	};
	const platform = { sendToast: vi.fn(async () => {}), setBadge: vi.fn() };
	vi.doMock("../src/auth/runtime.js", () => ({
		ProviderRuntime: class {
			initialize() {
				return options.initialize?.() || Promise.resolve();
			}
		},
	}));
	vi.doMock("../src/background/controller.js", () => ({
		createBackgroundController: () => controller,
	}));
	vi.doMock("../src/background/platform.js", () => ({
		createBackgroundPlatform: () => platform,
	}));
	vi.doMock("../src/background/pdf-controller.js", () => ({
		createPdfController: () => ({
			removeSessionByTab() {},
			handleConnect() {},
		}),
	}));
	const chrome = {
		runtime: {
			id: "extension",
			onInstalled: event(),
			onStartup: event(),
			onConnect: event(),
			onMessage: event(),
		},
		action: { onClicked: event() },
		contextMenus: { onClicked: event() },
		tabs: {
			onUpdated: event(),
			onRemoved: event(),
			sendMessage: vi.fn(async () => ({})),
		},
		permissions: { onRemoved: event() },
	};
	vi.stubGlobal("chrome", chrome);
	await import("../src/background/index.js");
	return { controller, platform, chrome };
}

afterEach(() => {
	vi.unstubAllGlobals();
	for (const module of [
		"../src/auth/runtime.js",
		"../src/background/controller.js",
		"../src/background/platform.js",
		"../src/background/pdf-controller.js",
	])
		vi.doUnmock(module);
	vi.resetModules();
});

for (const source of ["toolbar", "context-menu"]) {
	test(`${source} ignores failure from a superseded page action`, async () => {
		const f = await loadEntry();
		let failOld;
		f.controller.translatePage.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					failOld = reject;
				}),
		);
		f.controller.translatePage.mockResolvedValue({ sessionId: "new" });
		const click =
			source === "toolbar"
				? (tab) => f.chrome.action.onClicked.addListener.mock.calls[0][0](tab)
				: (tab) =>
						f.chrome.contextMenus.onClicked.addListener.mock.calls[0][0](
							{ menuItemId: "translate-page" },
							tab,
						);
		const tab = { id: 7, url: "https://example.invalid/article" };
		const old = click(tab);
		await Promise.resolve();
		await click(tab);
		failOld(new Error("Old content script disconnected"));
		await old;
		assert.equal(f.controller.removePageTranslationState.mock.calls.length, 0);
		assert.equal(f.chrome.tabs.sendMessage.mock.calls.length, 0);
		assert.equal(f.platform.sendToast.mock.calls.length, 0);
		assert.equal(f.platform.setBadge.mock.calls.length, 0);
	});
}

test("an unrelated selection setup failure does not deactivate a page session", async () => {
	const f = await loadEntry();
	f.controller.translateSelection.mockRejectedValue(
		new Error("No selected text"),
	);
	await f.chrome.contextMenus.onClicked.addListener.mock.calls[0][0](
		{ menuItemId: "translate-selection", selectionText: "", frameId: 0 },
		{ id: 7, url: "https://example.invalid/article" },
	);
	assert.equal(f.controller.removePageTranslationState.mock.calls.length, 0);
	assert.equal(f.chrome.tabs.sendMessage.mock.calls.length, 0);
	assert.equal(f.platform.sendToast.mock.calls.length, 1);
});

test("actions wait for trusted-storage initialization before translation", async () => {
	let ready;
	const initialization = new Promise((resolve) => {
		ready = resolve;
	});
	const f = await loadEntry({ initialize: () => initialization });
	const pending = f.chrome.action.onClicked.addListener.mock.calls[0][0]({
		id: 7,
		url: "https://example.invalid/article",
	});
	await Promise.resolve();
	assert.equal(f.controller.translatePage.mock.calls.length, 0);
	ready();
	await pending;
	assert.equal(f.controller.translatePage.mock.calls.length, 1);
});

test("storage initialization failure prevents translation", async () => {
	const f = await loadEntry({
		initialize: async () => {
			throw new Error("Storage restriction failed");
		},
	});
	await f.chrome.action.onClicked.addListener.mock.calls[0][0]({
		id: 7,
		url: "https://example.invalid/article",
	});
	assert.equal(f.controller.translatePage.mock.calls.length, 0);
});

test("navigation invalidates pending action failure UI", async () => {
	const f = await loadEntry();
	let fail;
	f.controller.translatePage.mockImplementation(
		() =>
			new Promise((_resolve, reject) => {
				fail = reject;
			}),
	);
	const pending = f.chrome.action.onClicked.addListener.mock.calls[0][0]({
		id: 7,
		url: "https://example.invalid/article",
	});
	await Promise.resolve();
	f.chrome.tabs.onUpdated.addListener.mock.calls[0][0](7, {
		status: "loading",
	});
	fail(new Error("Old content script disconnected"));
	await pending;
	assert.equal(f.controller.removePageTranslationState.mock.calls.length, 1);
	assert.equal(f.chrome.tabs.sendMessage.mock.calls.length, 0);
	assert.equal(f.platform.sendToast.mock.calls.length, 0);
	assert.deepEqual(f.platform.setBadge.mock.calls, [[7, ""]]);
});
