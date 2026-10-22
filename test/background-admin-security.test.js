import assert from "node:assert/strict";
import { test } from "vitest";

import { createBackgroundController } from "../src/background/controller.js";
import { createBackgroundPlatform } from "../src/background/platform.js";
import * as Messages from "../src/shared/messages.js";
import * as Settings from "../src/shared/settings.js";
import * as TranslationSession from "../src/shared/translation-session.js";

const runtimeId = "trusted-extension-id";
const optionsSender = {
	id: runtimeId,
	url: `chrome-extension://${runtimeId}/options/index.html`,
};
const settings = {
	...Settings.DEFAULT_SETTINGS,
	provider: Settings.CUSTOM_PROVIDER,
	model: "synthetic-model",
	customBaseUrl: "https://synthetic-endpoint.example/v1",
};

function createHarness({ allowed = true } = {}) {
	const calls = [];
	const network = [];
	const credentials = {
		async read() {
			calls.push("credential");
			return { key: "synthetic-stored-key" };
		},
	};
	const fetch = async (url, init) => {
		network.push({ url, init });
		return Response.json({ translation: "Synthetic translation" });
	};
	const ProviderRuntime = {
		async getCatalog() {
			calls.push("catalog");
			return [{ id: Settings.CUSTOM_PROVIDER }];
		},
		async getAuthStatus() {
			calls.push("status");
			await credentials.read();
			return { loggedIn: true };
		},
		async getModelEndpointPatterns(received) {
			calls.push("endpoints");
			assert.equal(received.customBaseUrl, settings.customBaseUrl);
			return ["https://synthetic-endpoint.example/*"];
		},
	};
	const chrome = {
		runtime: { id: runtimeId, getManifest: () => ({ version: "test" }) },
		permissions: {
			async contains(permission) {
				calls.push("contains");
				assert.deepEqual(permission.origins, [
					"https://synthetic-endpoint.example/*",
				]);
				return allowed;
			},
			async request() {
				calls.push("request-permission");
				return true;
			},
		},
	};
	const platform = createBackgroundPlatform({
		chrome,
		ProviderRuntime,
		Settings,
	});
	const ensureApiPermission = platform.ensureApiPermission;
	platform.ensureApiPermission = async (received, options) => {
		calls.push("permission");
		assert.deepEqual(options, { interactive: false });
		return ensureApiPermission(received, options);
	};
	const controller = createBackgroundController({
		chrome,
		Messages,
		Settings,
		TranslationSession,
		ProviderRuntime,
		platform,
		Api: {
			async requestTranslations(request) {
				calls.push("translation");
				const credential = await credentials.read();
				const response = await fetch(
					`${request.settings.customBaseUrl}/responses`,
					{
						headers: { Authorization: `Bearer ${credential.key}` },
					},
				);
				assert.equal(request.bypassCache, true);
				return [{ id: "sample", ...(await response.json()) }];
			},
		},
	});
	return { controller, calls, network };
}

const adminTypes = [
	Messages.MESSAGE_TYPES.TEST_CONNECTION,
	Messages.MESSAGE_TYPES.GET_PROVIDER_CATALOG,
	Messages.MESSAGE_TYPES.GET_PROVIDER_AUTH_STATUS,
	Messages.MESSAGE_TYPES.GET_MODEL_ENDPOINTS,
];

for (const [name, sender] of [
	[
		"web content script",
		{ id: runtimeId, url: "https://compromised.example/", tab: { id: 1 } },
	],
	[
		"content script without a tab",
		{ id: runtimeId, url: "https://compromised.example/" },
	],
	["foreign extension id", { id: "foreign", url: optionsSender.url }],
	[
		"foreign extension URL",
		{ id: runtimeId, url: "chrome-extension://foreign/options/index.html" },
	],
	["missing URL", { id: runtimeId }],
	["malformed URL", { id: runtimeId, url: "not a URL" }],
	[
		"extension URL with credentials",
		{
			id: runtimeId,
			url: `chrome-extension://user@${runtimeId}/options/index.html`,
		},
	],
	[
		"extension URL with a port",
		{
			id: runtimeId,
			url: `chrome-extension://${runtimeId}:123/options/index.html`,
		},
	],
	[
		"URL object instead of a string",
		{ id: runtimeId, url: new URL(optionsSender.url) },
	],
	[
		"lookalike host",
		{
			id: runtimeId,
			url: `chrome-extension://${runtimeId}.foreign/options/index.html`,
		},
	],
	[
		"web URL containing extension URL",
		{
			id: runtimeId,
			url: `https://compromised.example/chrome-extension://${runtimeId}/options/index.html`,
		},
	],
]) {
	for (const type of adminTypes) {
		test(`admin ${type} rejects ${name} before provider or credential access`, async () => {
			const { controller, calls, network } = createHarness();
			const response = await controller.handleRuntimeMessage(
				Messages.createMessage(type, settings),
				sender,
			);
			assert.equal(response.ok, false);
			assert.deepEqual(calls, []);
			assert.deepEqual(network, []);
		});
	}
}

test("connection test rejects denied permission without credentials, network, or interactive request", async () => {
	const { controller, calls, network } = createHarness({ allowed: false });
	await assert.rejects(
		controller.handleRuntimeMessage(
			Messages.createMessage(Messages.MESSAGE_TYPES.TEST_CONNECTION, settings),
			optionsSender,
		),
		/permission.*denied/iu,
	);
	assert.deepEqual(calls, ["permission", "endpoints", "contains"]);
	assert.deepEqual(network, []);
});

test("own Options page checks permission noninteractively before credential-bearing connection test", async () => {
	const { controller, calls, network } = createHarness();
	const response = await controller.handleRuntimeMessage(
		Messages.createMessage(Messages.MESSAGE_TYPES.TEST_CONNECTION, settings),
		optionsSender,
	);
	assert.equal(response.ok, true);
	assert.equal(response.translation, "Synthetic translation");
	assert.deepEqual(calls, [
		"permission",
		"endpoints",
		"contains",
		"translation",
		"credential",
	]);
	assert.equal(network.length, 1);
	assert.equal(
		network[0].url,
		"https://synthetic-endpoint.example/v1/responses",
	);
	assert.equal(
		network[0].init.headers.Authorization,
		"Bearer synthetic-stored-key",
	);
});

for (const [type, expectedCall] of [
	[Messages.MESSAGE_TYPES.GET_PROVIDER_CATALOG, "catalog"],
	[Messages.MESSAGE_TYPES.GET_PROVIDER_AUTH_STATUS, "status"],
	[Messages.MESSAGE_TYPES.GET_MODEL_ENDPOINTS, "endpoints"],
]) {
	test(`own Options page can use ${type}`, async () => {
		const { controller, calls, network } = createHarness();
		const response = await controller.handleRuntimeMessage(
			Messages.createMessage(type, settings),
			optionsSender,
		);
		assert.equal(response.ok, true);
		assert.equal(calls[0], expectedCall);
		assert.deepEqual(network, []);
	});
}

test("content scripts retain access to their page-session message", async () => {
	const { controller, calls, network } = createHarness();
	const response = await controller.handleRuntimeMessage(
		Messages.getPageTranslationSession(),
		{
			id: runtimeId,
			url: "https://compromised.example/",
			tab: { id: 1 },
			frameId: 0,
		},
	);
	assert.deepEqual(response, { ok: true, active: false });
	assert.deepEqual(calls, []);
	assert.deepEqual(network, []);
});
