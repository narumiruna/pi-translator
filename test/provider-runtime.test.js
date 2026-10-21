import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { test } from "vitest";

import { BROWSER_APIS } from "../src/auth/browser-apis.js";
import { getBrowserOAuthProviderIds } from "../src/auth/browser-oauth.js";
import { CREDENTIALS_KEY } from "../src/auth/credential-store.js";
import {
	LEGACY_MIGRATION_KEY,
	ProviderRuntime,
	summarizeModel,
} from "../src/auth/runtime.js";
import * as Settings from "../src/shared/settings.js";
import {
	clearTranslationCache,
	createTranslationApi,
} from "../src/translation/api.js";

const require = createRequire(import.meta.url);
const { createMockApiServer } = require("../e2e/lib/mock-api-server.cjs");

class MemoryStorage {
	values = {};
	accessLevel = "";

	async get(key) {
		if (typeof key === "string") {
			return { [key]: this.values[key] };
		}
		return { ...this.values };
	}

	async set(items) {
		Object.assign(this.values, structuredClone(items));
	}

	async remove(key) {
		for (const item of Array.isArray(key) ? key : [key]) {
			delete this.values[item];
		}
	}

	async setAccessLevel({ accessLevel }) {
		this.accessLevel = accessLevel;
	}
}

function createChrome() {
	return {
		storage: {
			local: new MemoryStorage(),
			sync: new MemoryStorage(),
		},
	};
}

test("provider runtime exposes every browser-compatible pi-ai catalog", async () => {
	const runtime = new ProviderRuntime({ chrome: createChrome() });
	const providers = await runtime.getCatalog(Settings.DEFAULT_SETTINGS);
	const providerIds = providers.map((provider) => provider.id);

	const expectedProviderIds = builtinProviders()
		.filter((provider) => provider.getModels().length > 0)
		.map((provider) => provider.id)
		.filter((providerId) => providerId !== "amazon-bedrock");
	assert.deepEqual(
		providerIds
			.filter((providerId) => providerId !== "openai-compatible")
			.sort(),
		expectedProviderIds.sort(),
	);
	assert.ok(providerIds.includes("openai"));
	assert.ok(providerIds.includes("openai-codex"));
	assert.ok(providerIds.includes("openrouter"));
	assert.ok(providerIds.includes("openai-compatible"));
	assert.equal(providerIds.includes("amazon-bedrock"), false);
	assert.equal(providerIds.includes("typesafe"), false);
	assert.ok(providerIds.includes("meta"));
	assert.deepEqual(
		providers
			.find((provider) => provider.id === "meta")
			.authMethods.map((method) => method.type),
		["api_key"],
	);
	assert.ok(
		providers.find((provider) => provider.id === "openrouter").models.length >
			300,
	);
	assert.deepEqual(
		providers
			.find((provider) => provider.id === "openai-codex")
			.authMethods.map((method) => method.type),
		["oauth"],
	);
	assert.deepEqual(
		providers
			.find((provider) => provider.id === "anthropic")
			.authMethods.map((method) => method.type),
		["api_key", "oauth"],
	);
	for (const providerId of getBrowserOAuthProviderIds()) {
		const provider = providers.find((item) => item.id === providerId);
		assert.ok(provider, `Missing browser OAuth provider ${providerId}`);
		assert.ok(
			provider.authMethods.some((method) => method.type === "oauth"),
			`Missing OAuth method for ${providerId}`,
		);
		assert.ok(
			provider.authMethods
				.find((method) => method.type === "oauth")
				.setupOrigins.every((origin) => origin.endsWith("/*")),
			`Invalid OAuth setup origin for ${providerId}`,
		);
	}
	assert.deepEqual(
		providers
			.find((provider) => provider.id === "radius")
			.authMethods.find((method) => method.type === "api_key").setupOrigins,
		["https://radius.pi.dev/*"],
	);
	for (const apiId of new Set(
		providers.flatMap((provider) => provider.models.map((model) => model.api)),
	)) {
		assert.ok(BROWSER_APIS[apiId], `Missing browser API adapter for ${apiId}`);
	}
});

test("model summaries expose only supported thinking levels", () => {
	const runtime = new ProviderRuntime({ chrome: createChrome() });
	for (const provider of runtime.models.getProviders()) {
		for (const model of provider.getModels()) {
			assert.deepEqual(
				summarizeModel(model).thinkingLevels,
				getSupportedThinkingLevels(model),
			);
		}
	}
	assert.deepEqual(
		summarizeModel({ id: "plain", reasoning: false }).thinkingLevels,
		["off"],
	);
	assert.deepEqual(
		summarizeModel({
			id: "limited",
			reasoning: true,
			thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: null },
		}).thinkingLevels,
		["low", "medium", "high", "xhigh"],
	);
});

test("provider completion forwards supported thinking levels and preserves defaults", async () => {
	const runtime = new ProviderRuntime({
		chrome: createChrome(),
		fetch: globalThis.fetch,
	});
	await runtime.credentials.modify("openai", async () => ({
		type: "api_key",
		key: "test-secret",
	}));
	await runtime.credentials.modify("anthropic", async () => ({
		type: "api_key",
		key: "test-secret",
	}));
	const calls = [];
	runtime.models.completeSimple = async (model, context, options) => {
		calls.push({ model, context, options });
		return {
			content: [{ type: "text", text: "Translated" }],
			stopReason: "stop",
		};
	};
	const signal = new AbortController().signal;
	const input = { systemPrompt: "System", userPrompt: "User" };
	const cases = [
		{
			provider: "openai",
			model: "gpt-5-mini",
			levels: ["minimal", "low", "medium", "high"],
		},
		{
			provider: "openai",
			model: "gpt-5.2",
			levels: ["low", "medium", "high", "xhigh"],
		},
		{
			provider: "anthropic",
			model: "claude-opus-4-6",
			levels: ["minimal", "low", "medium", "high", "max"],
		},
	];
	for (const settings of cases) {
		for (const thinkingLevel of settings.levels) {
			const response = await runtime.complete(
				{ ...settings, thinkingLevel: ` ${thinkingLevel.toUpperCase()} ` },
				input,
				{ signal },
			);
			assert.equal(response.text, "Translated");
			assert.equal(calls.at(-1).options.reasoning, thinkingLevel);
			assert.equal(calls.at(-1).options.signal, signal);
			assert.equal(calls.at(-1).options.fetch, globalThis.fetch);
			assert.equal(calls.at(-1).options.transport, "sse");
		}
	}
	for (const thinkingLevel of [
		undefined,
		"default",
		"off",
		"xhigh",
		"max",
		"invalid",
	]) {
		await runtime.complete(
			{ provider: "openai", model: "gpt-5-mini", thinkingLevel },
			input,
		);
		assert.equal("reasoning" in calls.at(-1).options, false);
	}
	await runtime.complete(
		{ provider: "openai", model: "gpt-4.1-mini", thinkingLevel: "high" },
		input,
	);
	assert.equal("reasoning" in calls.at(-1).options, false);
});

test("provider setup forwards cancellation to auth and stops waiting for ignored abort", async () => {
	const runtime = new ProviderRuntime({ chrome: createChrome() });
	const controller = new AbortController();
	let authSignal;
	let started;
	const authStarted = new Promise((resolve) => {
		started = resolve;
	});
	runtime.models.checkAuth = (_provider, options) => {
		authSignal = options?.signal;
		started();
		return new Promise(() => {});
	};
	const pending = runtime.complete(
		{ provider: "openai", model: "gpt-5-mini" },
		{ userPrompt: "Hello" },
		{ signal: controller.signal },
	);
	await authStarted;
	controller.abort();
	let timer;
	try {
		await assert.rejects(
			Promise.race([
				pending,
				new Promise((resolve) => {
					timer = setTimeout(resolve, 100);
				}),
			]),
			{ name: "AbortError" },
		);
		assert.equal(authSignal, controller.signal);
	} finally {
		clearTimeout(timer);
	}
});

test("provider completion stops waiting when the SDK ignores abort", async () => {
	const runtime = new ProviderRuntime({ chrome: createChrome() });
	await runtime.credentials.modify("openai", async () => ({
		type: "api_key",
		key: "mock-secret",
	}));
	const controller = new AbortController();
	let started;
	const completionStarted = new Promise((resolve) => {
		started = resolve;
	});
	let complete;
	runtime.models.completeSimple = () => {
		started();
		return new Promise((resolve) => {
			complete = resolve;
		});
	};
	const pending = runtime.complete(
		{ provider: "openai", model: "gpt-5-mini" },
		{ userPrompt: "Hello" },
		{ signal: controller.signal },
	);
	await completionStarted;
	controller.abort();
	let timer;
	try {
		await assert.rejects(
			Promise.race([
				pending,
				new Promise((resolve) => {
					timer = setTimeout(resolve, 100);
				}),
			]),
			{ name: "AbortError" },
		);
	} finally {
		clearTimeout(timer);
		complete({
			content: [{ type: "text", text: "Late success" }],
			stopReason: "stop",
		});
	}
});

test("provider runtime aborts a real HTTP SSE body stalled after headers", async () => {
	let closed;
	const connectionClosed = new Promise((resolve) => {
		closed = resolve;
	});
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.write(": connected\n\n");
			response.on("close", closed);
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const controller = new AbortController();
	let received;
	const headersReceived = new Promise((resolve) => {
		received = resolve;
	});
	let fetchSignal;
	const runtime = new ProviderRuntime({
		chrome: createChrome(),
		async fetch(url, options) {
			fetchSignal = options.signal;
			const response = await globalThis.fetch(url, options);
			received();
			return response;
		},
	});
	const api = createTranslationApi(runtime);
	let timer;
	try {
		await runtime.credentials.modify(Settings.CUSTOM_PROVIDER, async () => ({
			type: "api_key",
			key: "mock-secret",
		}));
		const pending = api.requestTranslations({
			settings: {
				...Settings.DEFAULT_SETTINGS,
				provider: Settings.CUSTOM_PROVIDER,
				customBaseUrl: `http://127.0.0.1:${server.address().port}/v1`,
				model: "stalled-model",
			},
			items: [{ id: "stalled-sse", kind: "subtitle", text: "Hello" }],
			signal: controller.signal,
		});
		await headersReceived;
		controller.abort(new DOMException("Batch deadline", "TimeoutError"));
		await assert.rejects(
			Promise.race([
				pending,
				new Promise((resolve) => {
					timer = setTimeout(resolve, 100);
				}),
			]),
			{ name: "TimeoutError" },
		);
		clearTimeout(timer);
		assert.equal(fetchSignal.aborted, true);
		await Promise.race([
			connectionClosed,
			new Promise((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("SSE connection stayed open")),
					1000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
		controller.abort();
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		clearTranslationCache();
	}
});

test("Meta models resolve browser endpoint permissions without exposing credentials", async () => {
	const runtime = new ProviderRuntime({ chrome: createChrome() });
	await runtime.credentials.modify("meta", async () => ({
		type: "api_key",
		key: "meta-secret",
	}));
	const model = runtime.models.getModels("meta")[0];
	assert.ok(model);
	assert.equal(model.api, "openai-responses");
	assert.deepEqual(
		await runtime.getModelEndpointPatterns({
			provider: "meta",
			model: model.id,
		}),
		["https://api.meta.ai/*"],
	);
});

test("provider runtime invalidates only the expected credential type", async () => {
	const runtime = new ProviderRuntime({ chrome: createChrome() });
	const providerId = "anthropic";
	const apiKey = { type: "api_key", key: "api-key" };

	await runtime.credentials.modify(providerId, async () => apiKey);
	await runtime.invalidateCredential(providerId, "oauth");
	assert.deepEqual(await runtime.credentials.read(providerId), apiKey);

	await runtime.credentials.modify(providerId, async () => ({
		type: "oauth",
		access: "access-token",
		expires: Date.now() + 60_000,
		refresh: "refresh-token",
	}));
	await runtime.invalidateCredential(providerId, "oauth");
	assert.equal(await runtime.credentials.read(providerId), undefined);
});

test("provider runtime migrates legacy secrets into trusted local credentials", async () => {
	const chrome = createChrome();
	chrome.storage.sync.values[Settings.STORAGE_KEY] = {
		apiKey: " legacy-secret ",
		baseUrl: "https://custom.example/v1/",
		model: "legacy-model",
		targetLanguage: "日本語",
	};
	const runtime = new ProviderRuntime({ chrome, settingsApi: Settings });

	await runtime.initialize();

	assert.equal(chrome.storage.local.accessLevel, "TRUSTED_CONTEXTS");
	assert.equal(chrome.storage.local.values[LEGACY_MIGRATION_KEY], true);
	assert.deepEqual(
		chrome.storage.local.values[CREDENTIALS_KEY][Settings.CUSTOM_PROVIDER],
		{ type: "api_key", key: "legacy-secret" },
	);
	const migrated = chrome.storage.sync.values[Settings.STORAGE_KEY];
	assert.equal(migrated.provider, Settings.CUSTOM_PROVIDER);
	assert.equal(migrated.customBaseUrl, "https://custom.example/v1");
	assert.equal("apiKey" in migrated, false);
	assert.equal("baseUrl" in migrated, false);
});

test("provider runtime resolves configured endpoint origins without credential data", async () => {
	const runtime = new ProviderRuntime({ chrome: createChrome() });
	await runtime.credentials.modify("cloudflare-workers-ai", async () => ({
		type: "api_key",
		key: "cloudflare-secret",
		env: { CLOUDFLARE_ACCOUNT_ID: "account-id" },
	}));
	const model = runtime.models.getModels("cloudflare-workers-ai")[0];
	const origins = await runtime.getModelEndpointPatterns({
		provider: "cloudflare-workers-ai",
		model: model.id,
	});

	assert.deepEqual(origins, ["https://api.cloudflare.com/*"]);
	assert.doesNotMatch(JSON.stringify(origins), /secret|account-id/u);
});

test("Azure login stores browser configuration and resolves the configured origin", async () => {
	const runtime = new ProviderRuntime({ chrome: createChrome() });
	const model = runtime.models
		.getModels("azure")
		.find((item) => item.api === "azure-openai-responses");
	const settings = { provider: "azure", model: model.id };
	await assert.rejects(
		runtime.getModelEndpointPatterns(settings),
		/No browser endpoint is configured/u,
	);

	const answers = [
		" azure-secret ",
		" https://resource.openai.azure.com ",
		" 2025-04-01-preview ",
		` ${model.id}=translation-deployment `,
	];
	const prompts = [];
	await runtime.login("azure", "api_key", {
		async prompt(prompt) {
			prompts.push(prompt);
			return answers.shift();
		},
	});

	assert.equal(prompts.length, 4);
	assert.deepEqual(await runtime.credentials.read("azure"), {
		type: "api_key",
		key: "azure-secret",
		env: {
			AZURE_OPENAI_BASE_URL: "https://resource.openai.azure.com",
			AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
			AZURE_OPENAI_DEPLOYMENT_NAME_MAP: `${model.id}=translation-deployment`,
		},
	});
	assert.deepEqual(await runtime.getModelEndpointPatterns(settings), [
		"https://resource.openai.azure.com/*",
	]);
	assert.equal((await runtime.getAuthStatus("azure")).loggedIn, true);
});

test("model cache identity tracks credential-scoped endpoint configuration", async () => {
	const runtime = new ProviderRuntime({ chrome: createChrome() });
	const providerId = "azure";
	const model = runtime.models.getModels(providerId)[0];
	const settings = { provider: providerId, model: model.id };
	const saveCredential = (env) =>
		runtime.credentials.modify(providerId, async () => ({
			type: "api_key",
			key: "azure-secret",
			env,
		}));

	await saveCredential({
		AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
		AZURE_OPENAI_BASE_URL: "https://first.openai.azure.com",
		AZURE_OPENAI_DEPLOYMENT_NAME_MAP: `${model.id}=first-deployment`,
	});
	const firstIdentity = await runtime.getModelCacheIdentity(settings);
	await saveCredential({
		AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
		AZURE_OPENAI_BASE_URL: "https://first.openai.azure.com",
		AZURE_OPENAI_DEPLOYMENT_NAME_MAP: `${model.id}=second-deployment`,
	});
	const secondDeploymentIdentity =
		await runtime.getModelCacheIdentity(settings);
	await saveCredential({
		AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
		AZURE_OPENAI_BASE_URL: "https://second.openai.azure.com",
		AZURE_OPENAI_DEPLOYMENT_NAME_MAP: `${model.id}=second-deployment`,
	});
	const secondEndpointIdentity = await runtime.getModelCacheIdentity(settings);

	assert.match(firstIdentity, /^[a-f0-9]{64}$/u);
	assert.notEqual(firstIdentity, secondDeploymentIdentity);
	assert.notEqual(secondDeploymentIdentity, secondEndpointIdentity);
	assert.doesNotMatch(
		[firstIdentity, secondDeploymentIdentity, secondEndpointIdentity].join(""),
		/azure-secret|openai\.azure/u,
	);
});

test("provider translation cache follows the runtime model identity", async () => {
	clearTranslationCache();
	let calls = 0;
	let modelCacheIdentity = "backend-one";
	const seenIdentities = [];
	const api = createTranslationApi({
		async complete(settings) {
			calls += 1;
			seenIdentities.push(settings.modelCacheIdentity);
			return {
				text: JSON.stringify({
					translations: [{ id: "a", translation: `result-${calls}` }],
				}),
			};
		},
		async getModelCacheIdentity() {
			return modelCacheIdentity;
		},
	});
	const settings = Settings.DEFAULT_SETTINGS;
	const items = [{ id: "a", kind: "paragraph", text: "Alpha" }];

	const first = await api.requestTranslations({ settings, items });
	modelCacheIdentity = "backend-two";
	const second = await api.requestTranslations({ settings, items });

	assert.equal(calls, 2);
	assert.deepEqual(seenIdentities, ["backend-one", "backend-two"]);
	assert.deepEqual(first, [{ id: "a", translation: "result-1" }]);
	assert.deepEqual(second, [{ id: "a", translation: "result-2" }]);
});

test("production custom requests apply thinking levels and separate cached results", async () => {
	clearTranslationCache();
	const server = await createMockApiServer();
	const payloads = [];
	const runtime = new ProviderRuntime({
		chrome: createChrome(),
		fetch(url, init) {
			payloads.push(JSON.parse(init.body));
			return globalThis.fetch(url, init);
		},
	});
	const api = createTranslationApi(runtime);
	const settings = {
		...Settings.DEFAULT_SETTINGS,
		provider: Settings.CUSTOM_PROVIDER,
		customBaseUrl: server.baseUrl,
		model: "mock-thinking",
	};
	try {
		await runtime.credentials.modify(Settings.CUSTOM_PROVIDER, async () => ({
			type: "api_key",
			key: "mock-secret",
		}));
		for (const [thinkingLevel, effort] of [
			[undefined, undefined],
			["default", undefined],
			["off", "none"],
			["minimal", "minimal"],
			["low", "low"],
			["medium", "medium"],
			["high", "high"],
			["xhigh", undefined],
			["max", undefined],
			["default", undefined],
		]) {
			const before = payloads.length;
			await api.requestTranslations({
				settings: { ...settings, thinkingLevel },
				items: [{ id: "a", kind: "paragraph", text: "Alpha" }],
			});
			if (thinkingLevel === "default") {
				assert.equal(
					payloads.length,
					before,
					"Default and legacy settings reuse the same cache",
				);
			} else {
				assert.equal(payloads.length, before + 1);
				assert.equal(payloads.at(-1).reasoning?.effort, effort);
				if (effort === undefined)
					assert.equal("reasoning" in payloads.at(-1), false);
			}
		}
	} finally {
		await server.close();
		clearTranslationCache();
	}
});

test("production translation adapter sends custom provider requests through pi-ai", async () => {
	const server = await createMockApiServer();
	const runtime = new ProviderRuntime({ chrome: createChrome() });
	const api = createTranslationApi(runtime);
	const settings = Settings.validateSettings({
		...Settings.DEFAULT_SETTINGS,
		provider: Settings.CUSTOM_PROVIDER,
		customBaseUrl: server.baseUrl,
		model: "mock-model",
	}).settings;

	try {
		await runtime.credentials.modify(Settings.CUSTOM_PROVIDER, async () => ({
			type: "api_key",
			key: "mock-secret",
		}));
		const translations = await api.requestTranslations({
			settings,
			items: [{ id: "a", kind: "paragraph", text: "Alpha" }],
		});

		assert.deepEqual(translations, [{ id: "a", translation: "[mock:Alpha]" }]);
		assert.equal(server.getResponseRequestCount(), 1);
	} finally {
		await server.close();
	}
});
