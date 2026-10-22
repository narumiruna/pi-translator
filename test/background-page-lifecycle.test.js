import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createBackgroundController } from "../src/background/controller.js";
import * as Messages from "../src/shared/messages.js";
import * as Settings from "../src/shared/settings.js";
import * as TranslationSession from "../src/shared/translation-session.js";
import * as Api from "../src/translation/api.js";

const tab = { id: 7, url: "https://example.invalid/article" };
const flush = async () => {
	for (let i = 0; i < 60; i += 1) await Promise.resolve();
};
function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function fixture(options = {}) {
	const sent = [];
	const requests = [];
	const errors = [];
	const settings = Settings.DEFAULT_SETTINGS;
	const platform = {
		buildDebugPayload: () => ({}),
		buildTranslationAppearancePayload: () => ({}),
		buildYoutubeSubtitlePayload: () => ({}),
		clearPagePlaceholders: vi.fn(options.clearPlaceholders || (async () => {})),
		discoverEmbeddedPageFrames: async () => options.frames || [],
		ensureApiPermission: async () => true,
		ensureContentScript: async () => {},
		getFrameMessageOptions: (frameId) => ({ frameId }),
		isDomainDisabled: () => false,
		isSupportedPage: () => true,
		isTabMessageDisconnectError: (error) =>
			/Receiving end|No tab/.test(error.message),
		loadSettingsOrOpenOptions: options.loadSettings || (async () => settings),
		renderPageTranslationUpdates: vi.fn(
			async (_tab, _language, translations) => ({
				ok: true,
				renderedIds: translations.map(({ id }) => id),
			}),
		),
		sendToast: vi.fn(async () => {}),
		sendYoutubeDiagnosticEvent: vi.fn(async () => {}),
		setBadge: vi.fn(),
	};
	const chrome = {
		runtime: { id: "extension" },
		tabs: {
			sendMessage: async (_tab, message, frame) => {
				sent.push({ message, frame });
				if (
					message.type === Messages.MESSAGE_TYPES.START_PAGE_TRANSLATION_SESSION
				) {
					return (
						options.extract?.(message, frame) ?? { items: [], totalSegments: 1 }
					);
				}
				return { ok: true };
			},
		},
	};
	const api = {
		...Api,
		async requestTranslationsBatchedProgressive(request) {
			requests.push(request);
			if (options.request) return options.request(request);
			const translations = request.chunks
				.flat()
				.map(({ id }) => ({ id, translation: "Translated" }));
			await request.onChunkResolved({ translations });
			return { successes: translations, failures: [] };
		},
	};
	const controller = createBackgroundController({
		chrome,
		Api: options.Api || api,
		Messages,
		Settings,
		TranslationSession,
		SiteProfiles: {},
		platform,
		logger: {
			debug() {},
			info() {},
			error(event) {
				errors.push(event);
			},
		},
	});
	return { controller, platform, sent, requests, errors, settings };
}

afterEach(() => {
	vi.useRealTimers();
	Api.clearTranslationCache();
});

test("page teardown aborts active provider work without late rendering or cache writes", async () => {
	const gate = deferred();
	let providerSignal;
	let calls = 0;
	const api = Api.createTranslationApi({
		getModelCacheIdentity: async () => "page-abort-test",
		complete: async (_settings, _input, options) => {
			calls += 1;
			providerSignal = options.signal;
			return gate.promise;
		},
	});
	const f = fixture({ Api: api });
	const session = f.controller.pageTranslationQueue.create(tab.id, f.settings);
	const item = {
		id: "paragraph",
		kind: "paragraph",
		text: "A cancellable paragraph.",
	};
	f.controller.pageTranslationQueue.enqueue(tab.id, session.sessionId, [item]);
	await flush();
	assert.equal(calls, 1);
	f.controller.removePageTranslationState(tab.id);
	await flush();
	assert.equal(providerSignal?.aborted, true);
	gate.resolve({
		text: JSON.stringify({
			translations: [{ id: "paragraph", translatedText: "Translated" }],
		}),
	});
	await flush();
	assert.equal(f.platform.renderPageTranslationUpdates.mock.calls.length, 0);
	assert.equal(f.errors.length, 0);
	await api.requestTranslations({ settings: f.settings, items: [item] });
	assert.equal(
		calls,
		2,
		"Canceled results must not enter the translation cache.",
	);
});

test("ordinary page batch deadline releases the slot and starts the next source", async () => {
	vi.useFakeTimers();
	const f = fixture({
		clearPlaceholders: () => new Promise(() => {}),
		async request(request) {
			if (request.chunks[0][0].id.startsWith("stall"))
				return new Promise(() => {});
			const translations = request.chunks
				.flat()
				.map(({ id }) => ({ id, translation: "Translated" }));
			await request.onChunkResolved({ translations });
			return { successes: translations, failures: [] };
		},
	});
	const session = f.controller.pageTranslationQueue.create(tab.id, f.settings);
	f.controller.pageTranslationQueue.enqueue(
		tab.id,
		session.sessionId,
		Array.from({ length: 6 }, (_, i) => ({
			id: i < 5 ? `stall-${i}` : "next",
			kind: "paragraph",
			text: `Source ${i}`,
		})),
	);
	await flush();
	assert.equal(f.requests.length, 5);
	await vi.advanceTimersByTimeAsync(120_000);
	await flush();
	assert.equal(f.requests.length, 6);
	assert.ok(f.requests.slice(0, 5).every(({ signal }) => signal?.aborted));
	assert.equal(session.inFlightCount, 0);
	assert.ok(f.platform.clearPagePlaceholders.mock.calls.length >= 5);
	assert.equal(f.platform.sendYoutubeDiagnosticEvent.mock.calls.length, 0);
	assert.ok(f.platform.sendToast.mock.calls.length > 0);
	f.controller.removePageTranslationState(tab.id);
});
