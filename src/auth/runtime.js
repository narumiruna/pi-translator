import {
	createModels,
	getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";

import { waitForAbortable } from "../shared/abort.js";
import {
	BASIC_THINKING_LEVELS,
	normalizeThinkingLevel,
} from "../shared/settings.js";

import { getBrowserOAuthOrigins } from "./browser-oauth.js";
import { OPENAI_PROVIDER_ID } from "./codex-oauth.js";
import { ChromeCredentialStore } from "./credential-store.js";
import {
	CUSTOM_PROVIDER_ID,
	createBrowserProviders,
	createCustomProvider,
	modelEndpointUrls,
	RADIUS_CONFIG_URL,
} from "./providers.js";

const LEGACY_MIGRATION_KEY = "vibeTranslatorPiAiMigrationV1";

function toPermissionPattern(value) {
	const url = new URL(value);
	if (!/^https?:$/u.test(url.protocol)) {
		throw new Error("Provider endpoints must use HTTP or HTTPS.");
	}
	return `${url.origin}/*`;
}

function summarizeModel(model) {
	return {
		api: model.api,
		contextWindow: model.contextWindow,
		id: model.id,
		input: [...(model.input || [])],
		name: model.name || model.id,
		reasoning: Boolean(model.reasoning),
		thinkingLevels: getSupportedThinkingLevels(model),
	};
}

function summarizeProvider(provider) {
	const oauthOrigins = getBrowserOAuthOrigins(provider.id);
	const apiKeyOrigins =
		provider.id === "radius" ? [toPermissionPattern(RADIUS_CONFIG_URL)] : [];
	return {
		authMethods: [
			...(provider.auth.apiKey?.login
				? [
						{
							label: provider.auth.apiKey.name,
							setupOrigins: apiKeyOrigins,
							type: "api_key",
						},
					]
				: []),
			...(provider.auth.oauth
				? [
						{
							label: provider.auth.oauth.loginLabel || provider.auth.oauth.name,
							setupOrigins: oauthOrigins,
							type: "oauth",
						},
					]
				: []),
		],
		id: provider.id,
		models: provider.getModels().map(summarizeModel),
		name: provider.name,
	};
}

function extractAssistantText(message) {
	return (message?.content || [])
		.filter((item) => item?.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();
}

function normalizeProviderConfiguration(credential) {
	if (credential?.type !== "api_key" || !credential.env) {
		return {};
	}

	return Object.fromEntries(
		Object.entries(credential.env)
			.filter(([, value]) =>
				["boolean", "number", "string"].includes(typeof value),
			)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, value]) => [key, String(value)]),
	);
}

async function hashModelCacheIdentity(value) {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(value)),
	);
	return Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

class ProviderRuntime {
	constructor(options = {}) {
		this.chrome = options.chrome || globalThis.chrome;
		this.settingsApi = options.settingsApi;
		this.credentials =
			options.credentials ||
			new ChromeCredentialStore(this.chrome?.storage?.local);
		this.models = createModels({
			credentials: this.credentials,
			authContext: {
				async env() {
					return undefined;
				},
				async fileExists() {
					return false;
				},
			},
		});
		this.fetch = options.fetch;
		this.initialized = false;
		this.initializing = null;

		for (const provider of createBrowserProviders()) {
			this.models.setProvider(provider);
		}
		this.models.setProvider(createCustomProvider());
	}

	initialize() {
		if (!this.initializing) {
			this.initializing = this.doInitialize();
		}
		return this.initializing;
	}

	async doInitialize() {
		if (this.chrome?.storage?.local?.setAccessLevel) {
			await this.chrome.storage.local.setAccessLevel({
				accessLevel: "TRUSTED_CONTEXTS",
			});
		}
		await this.migrateLegacySettings();
		this.initialized = true;
	}

	async migrateLegacySettings() {
		if (!this.settingsApi || !this.chrome?.storage?.sync) {
			return;
		}

		const migration = await this.chrome.storage.local.get(LEGACY_MIGRATION_KEY);
		if (migration[LEGACY_MIGRATION_KEY]) {
			return;
		}

		const stored = await this.chrome.storage.sync.get(
			this.settingsApi.STORAGE_KEY,
		);
		const raw = stored[this.settingsApi.STORAGE_KEY];

		if (raw && typeof raw === "object") {
			const settings = this.settingsApi.validateSettings(raw).settings;
			const legacyKey = String(raw.apiKey || "").trim();
			if (legacyKey) {
				await this.credentials.modify(
					settings.provider,
					async (current) => current || { type: "api_key", key: legacyKey },
				);
			}
			await this.chrome.storage.sync.set({
				[this.settingsApi.STORAGE_KEY]: settings,
			});
		}

		await this.chrome.storage.local.set({ [LEGACY_MIGRATION_KEY]: true });
	}

	configureCustom(settings) {
		if (settings?.provider !== CUSTOM_PROVIDER_ID) {
			return;
		}
		this.models.setProvider(
			createCustomProvider({
				baseUrl: settings.customBaseUrl,
				model: settings.model,
				reasoning: BASIC_THINKING_LEVELS.includes(
					normalizeThinkingLevel(settings.thinkingLevel),
				),
			}),
		);
	}

	async getCatalog(settings) {
		await this.initialize();
		this.configureCustom(settings);
		return this.models.getProviders().map(summarizeProvider);
	}

	async getAuthStatus(providerId) {
		await this.initialize();
		const provider = this.models.getProvider(providerId);
		if (!provider) {
			return { loggedIn: false };
		}

		const credential = await this.credentials.read(providerId);
		if (!credential) {
			return { loggedIn: false };
		}

		const configured = await this.models.checkAuth(providerId);
		return configured
			? { loggedIn: true, source: configured.source, type: credential.type }
			: { loggedIn: false };
	}

	async login(providerId, authType, interaction) {
		await this.initialize();
		const credential = await this.models.login(
			providerId,
			authType,
			interaction,
		);
		if (providerId === "radius") {
			const result = await this.models.refresh({
				providers: [providerId],
				force: true,
				signal: interaction.signal,
			});
			const error = result.errors.get(providerId);
			if (error) {
				throw error;
			}
		}
		return credential;
	}

	async refreshCredential(providerId, signal) {
		await this.initialize();
		const auth = await this.models.getAuth(providerId, {
			minOAuthValidityMs: Number.MAX_SAFE_INTEGER,
			signal,
		});
		if (!auth) {
			throw new Error(
				"Configure this provider before refreshing its credential.",
			);
		}
	}

	async logout(providerId, signal) {
		await this.initialize();
		await this.models.logout(providerId, { signal });
	}

	async invalidateCredential(providerId = OPENAI_PROVIDER_ID, expectedType) {
		await this.initialize();
		await this.credentials.delete(
			providerId,
			expectedType ? { expectedType } : undefined,
		);
	}

	async getModel(settings, options = {}) {
		const signal = options.signal;
		signal?.throwIfAborted();
		await waitForAbortable(this.initialize(), signal);
		signal?.throwIfAborted();
		this.configureCustom(settings);
		const model = this.models.getModel(settings.provider, settings.model);
		if (!model) {
			throw new Error(
				`Selected model is unavailable: ${settings.provider}/${settings.model}.`,
			);
		}
		return model;
	}

	async assertConfigured(settings, options = {}) {
		const signal = options.signal;
		signal?.throwIfAborted();
		const model = await waitForAbortable(
			this.getModel(settings, options),
			signal,
		);
		signal?.throwIfAborted();
		const configured = await waitForAbortable(
			this.models.checkAuth(model.provider, { signal }),
			signal,
		);
		signal?.throwIfAborted();
		if (!configured) {
			throw new Error(
				"The selected provider is not configured. Open Settings and add a credential.",
			);
		}
		return model;
	}

	async getModelEndpointPatterns(settings) {
		const model = await this.getModel(settings);
		const provider = this.models.getProvider(model.provider);
		if (!provider) {
			throw new Error(`Provider is unavailable: ${model.provider}.`);
		}
		const credential = await this.credentials.read(provider.id);
		const urls = modelEndpointUrls(provider, model, credential);
		if (urls.length === 0) {
			throw new Error(
				`No browser endpoint is configured for ${provider.name}.`,
			);
		}
		return [...new Set(urls.map(toPermissionPattern))];
	}

	async getModelCacheIdentity(settings, options = {}) {
		const signal = options.signal;
		signal?.throwIfAborted();
		const model = await waitForAbortable(
			this.getModel(settings, options),
			signal,
		);
		signal?.throwIfAborted();
		const provider = this.models.getProvider(model.provider);
		if (!provider) {
			throw new Error(`Provider is unavailable: ${model.provider}.`);
		}
		const credential = await waitForAbortable(
			this.credentials.read(provider.id),
			signal,
		);
		signal?.throwIfAborted();
		const endpoints = [
			...new Set(modelEndpointUrls(provider, model, credential)),
		].sort();

		return waitForAbortable(
			hashModelCacheIdentity({
				configuration: normalizeProviderConfiguration(credential),
				endpoints,
				model: model.id,
				provider: provider.id,
			}),
			signal,
		);
	}

	async complete(settings, input, options = {}) {
		const signal = options.signal;
		signal?.throwIfAborted();
		const model = await waitForAbortable(
			this.assertConfigured(settings, options),
			signal,
		);
		signal?.throwIfAborted();
		const context = {
			systemPrompt: String(input?.systemPrompt || ""),
			messages: [
				{
					role: "user",
					content: String(input?.userPrompt || ""),
					timestamp: Date.now(),
				},
			],
		};
		const thinkingLevel = normalizeThinkingLevel(settings.thinkingLevel);
		const reasoning =
			thinkingLevel !== "default" &&
			thinkingLevel !== "off" &&
			getSupportedThinkingLevels(model).includes(thinkingLevel)
				? thinkingLevel
				: undefined;
		const response = await waitForAbortable(
			this.models.completeSimple(model, context, {
				...(reasoning ? { reasoning } : {}),
				...(this.fetch ? { fetch: this.fetch } : {}),
				...(options.signal ? { signal: options.signal } : {}),
				transport: "sse",
			}),
			signal,
		);
		signal?.throwIfAborted();

		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new Error(response.errorMessage || "The provider request failed.");
		}
		const text = extractAssistantText(response);
		if (!text) {
			throw new Error("The provider returned no translation text.");
		}
		return {
			text,
			usage: response.usage,
			provider: response.provider,
			model: response.model,
		};
	}
}

export {
	extractAssistantText,
	LEGACY_MIGRATION_KEY,
	ProviderRuntime,
	summarizeModel,
	summarizeProvider,
	toPermissionPattern,
};
