import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { ProviderRuntime } from "../src/auth/runtime.js";
import { createBackgroundController } from "../src/background/controller.js";
import { createBackgroundPlatform } from "../src/background/platform.js";
import { createYoutubeCaptionPrefetch } from "../src/background/youtube-caption-prefetch.js";
import * as Messages from "../src/shared/messages.js";
import * as Settings from "../src/shared/settings.js";
import * as TranslationSession from "../src/shared/translation-session.js";
import { createTranslationApi } from "../src/translation/api.js";

const sender = { id: "extension", tab: { id: 1 }, frameId: 0 };
const caption = (id) => ({
	id,
	kind: "subtitle",
	text: "Native caption",
	dedupeCompleted: true,
});
const flush = async () => {
	for (let i = 0; i < 40; i += 1) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

function fixture(options = {}) {
	const sent = [];
	const requests = [];
	const settings = {
		...Settings.DEFAULT_SETTINGS,
		targetLanguage: "French",
		...options.settings,
	};
	const chrome = {
		runtime: {
			id: "extension",
			openOptionsPage: vi.fn(),
			getManifest: () => ({}),
		},
		action: {
			setBadgeText: async () => {},
			setBadgeBackgroundColor: async () => {},
		},
		permissions: {
			contains: async () => options.permission !== false,
			request: vi.fn(async () => true),
		},
		scripting: {
			executeScript:
				options.executeScript ||
				(async () => [{ result: { enabled: true, hasTrack: false } }]),
		},
		tabs: {
			get: async () => ({
				id: 1,
				url: options.url || "https://www.youtube.com/watch?v=video-a",
			}),
			async sendMessage(_tab, message) {
				sent.push(message);
				if (options.sendMessage) {
					const value = options.sendMessage(message);
					if (value !== undefined) return value;
				}
				if (
					message.type === Messages.MESSAGE_TYPES.START_PAGE_TRANSLATION_SESSION
				)
					return { items: [], keepAlive: true };
				return { ok: true, rendered: 0 };
			},
		},
	};
	const platform = createBackgroundPlatform({
		chrome,
		Messages,
		Settings: {
			...Settings,
			getSettings: async () => settings,
			hasCompleteSettings: () => options.complete !== false,
		},
		Appearance: { normalizeTranslationAppearance: (value) => value },
		EmbeddedFrames: { discoverEmbeddedFrames: async () => [] },
		SiteProfiles: {},
		ProviderRuntime: options.ProviderRuntime,
	});
	const Api = {
		createRecursiveChunkPlan: (items) => ({ chunks: [items], items }),
		createProgressiveMergeState: () => ({}),
		consumeProgressiveTranslations: (_plan, _state, translations) =>
			translations,
		getIncompleteSegmentIds: options.getIncompleteSegmentIds || (() => []),
		async requestTranslationsBatchedProgressive(request) {
			requests.push(request);
			if (options.request) return options.request(request);
			await request.onChunkResolved({
				translations: request.chunks
					.flat()
					.map((item) => ({ ...item, translation: "Translated" })),
			});
			return { failures: [] };
		},
	};
	const controller = createBackgroundController({
		chrome,
		Api: options.Api || Api,
		Messages,
		Settings,
		TranslationSession,
		SiteProfiles: { resolveSiteProfile: () => ({ id: "youtube" }) },
		platform,
		fetch: options.fetch,
	});
	const session =
		options.createSession === false
			? null
			: controller.pageTranslationQueue.create(1, settings, 0);
	const send = (type, payload) =>
		controller.handleRuntimeMessage(
			{ type: Messages.MESSAGE_TYPES[type], payload },
			sender,
		);
	return { controller, session, send, sent, requests, chrome };
}

test.each([
	[401, "invalid_api_key"],
	[403, "permission_denied"],
	[404, "model_not_found"],
])(
	"actual provider SDK HTTP %s errors stop subtitle retries after metadata is flattened",
	async (status, code) => {
		function memoryStorage() {
			const values = {};
			return {
				async get(key) {
					return typeof key === "string"
						? { [key]: values[key] }
						: { ...values };
				},
				async set(items) {
					Object.assign(values, items);
				},
				async remove(key) {
					delete values[key];
				},
			};
		}
		let fetches = 0;
		const runtime = new ProviderRuntime({
			chrome: { storage: { local: memoryStorage(), sync: memoryStorage() } },
			fetch: async () => {
				fetches++;
				return new Response(
					JSON.stringify({
						error: {
							message: "Synthetic permanent configuration failure",
							type: "invalid_request_error",
							code,
						},
					}),
					{ status, headers: { "Content-Type": "application/json" } },
				);
			},
		});
		await runtime.credentials.modify(Settings.CUSTOM_PROVIDER, async () => ({
			type: "api_key",
			key: "synthetic-test-only",
		}));
		const f = fixture({
			Api: createTranslationApi(runtime),
			settings: {
				provider: Settings.CUSTOM_PROVIDER,
				customBaseUrl: "https://example.invalid/v1",
				model: `synthetic-missing-model-${status}`,
			},
		});
		await f.send("QUEUE_PAGE_TRANSLATION_ITEMS", {
			sessionId: f.session.sessionId,
			items: [caption("sdk-error")],
		});
		await vi.waitFor(() =>
			assert.ok(
				f.sent.some(
					(message) =>
						message.type === Messages.MESSAGE_TYPES.CLEAR_PAGE_PLACEHOLDERS,
				),
			),
		);
		const clear = f.sent.find(
			(message) =>
				message.type === Messages.MESSAGE_TYPES.CLEAR_PAGE_PLACEHOLDERS,
		).payload;
		assert.equal(clear.reason, "setup-error");
		assert.equal(clear.retryable, false);
		assert.equal(fetches, 1);
		assert.doesNotMatch(
			JSON.stringify(f.sent),
			/synthetic-test-only|Synthetic permanent configuration failure/,
		);
		f.controller.removePageTranslationState(1);
	},
);

test("scoped teardown cancels the current queue but cannot cancel a replacement session", async () => {
	const f = fixture({ request: () => new Promise(() => {}) });
	await f.send("QUEUE_PAGE_TRANSLATION_ITEMS", {
		sessionId: f.session.sessionId,
		items: [caption("cancel")],
	});
	await flush();
	assert.deepEqual(
		await f.send("CANCEL_YOUTUBE_SUBTITLE_TRANSLATION", {
			sessionId: f.session.sessionId,
			videoKey: "video-a",
		}),
		{ ok: true, cancelled: true },
	);
	assert.equal(f.session.signal.aborted, true);
	assert.equal(f.controller.pageTranslationQueue.get(1), null);
	const replacement = f.controller.pageTranslationQueue.create(1, {});
	assert.deepEqual(
		await f.send("CANCEL_YOUTUBE_SUBTITLE_TRANSLATION", {
			sessionId: f.session.sessionId,
			videoKey: "video-a",
		}),
		{ ok: true, cancelled: false },
	);
	assert.equal(replacement.signal.aborted, false);
	f.controller.removePageTranslationState(1);
});

test("delayed teardown of an old session does not abort a newer startup awaiting permission", async () => {
	const f = fixture();
	let grant;
	f.chrome.permissions.contains = () =>
		new Promise((resolve) => {
			grant = resolve;
		});
	const startup = f.send("START_YOUTUBE_SUBTITLE_TRANSLATION", {
		videoKey: "video-a",
		requestId: "new-start",
		recovery: true,
	});
	await flush();
	assert.equal(
		(
			await f.send("CANCEL_YOUTUBE_SUBTITLE_TRANSLATION", {
				sessionId: f.session.sessionId,
				requestId: "old-start",
				videoKey: "video-a",
			})
		).cancelled,
		true,
	);
	grant(true);
	const result = await startup;
	assert.equal(result.ok, true);
	assert.equal(
		f.controller.pageTranslationQueue.get(1).sessionId,
		result.sessionId,
	);
	f.controller.removePageTranslationState(1);
});

test("teardown cancels a matching startup request before its caption probe completes", async () => {
	const f = fixture({
		createSession: false,
		executeScript: () => new Promise(() => {}),
	});
	const startup = f.send("START_YOUTUBE_SUBTITLE_TRANSLATION", {
		videoKey: "video-a",
		requestId: "pending-start",
		recovery: true,
	});
	await flush();
	assert.equal(
		(
			await f.send("CANCEL_YOUTUBE_SUBTITLE_TRANSLATION", {
				videoKey: "video-a",
				requestId: "older-start",
			})
		).cancelled,
		false,
	);
	assert.equal(
		(
			await f.send("CANCEL_YOUTUBE_SUBTITLE_TRANSLATION", {
				videoKey: "video-a",
				requestId: "pending-start",
			})
		).cancelled,
		true,
	);
	const result = await startup;
	assert.equal(result.ok, false);
	assert.equal(result.retryable, false);
	assert.equal(f.controller.pageTranslationQueue.get(1), null);
});

test("fresh controller distinguishes missing state from stale, empty, and duplicate work", async () => {
	const original = fixture();
	const f = fixture({
		createSession: false,
		request: () => new Promise(() => {}),
	});
	assert.deepEqual(
		await f.send("QUEUE_PAGE_TRANSLATION_ITEMS", {
			sessionId: original.session.sessionId,
			items: [caption("a")],
		}),
		{ ok: true, queued: 0, sessionStatus: "missing" },
	);
	const current = f.controller.pageTranslationQueue.create(1, {});
	assert.equal(
		(
			await f.send("QUEUE_PAGE_TRANSLATION_ITEMS", {
				sessionId: "old",
				items: [],
			})
		).sessionStatus,
		"stale",
	);
	assert.equal(
		(
			await f.send("QUEUE_PAGE_TRANSLATION_ITEMS", {
				sessionId: current.sessionId,
				items: [],
			})
		).sessionStatus,
		"active",
	);
	await f.send("QUEUE_PAGE_TRANSLATION_ITEMS", {
		sessionId: current.sessionId,
		items: [caption("a")],
	});
	assert.deepEqual(
		await f.send("QUEUE_PAGE_TRANSLATION_ITEMS", {
			sessionId: current.sessionId,
			items: [caption("a")],
		}),
		{ ok: true, queued: 0, sessionStatus: "active" },
	);
	f.controller.removePageTranslationState(1);
});

test("prefetch distinguishes valid unavailable tracks from missing and stale translation sessions", async () => {
	const f = fixture();
	assert.deepEqual(
		await f.send("PREFETCH_YOUTUBE_SUBTITLES", {
			sessionId: f.session.sessionId,
		}),
		{ available: false, queued: 0, sessionStatus: "active" },
	);
	assert.equal(
		(await f.send("PREFETCH_YOUTUBE_SUBTITLES", { sessionId: "old" }))
			.sessionStatus,
		"stale",
	);
	f.controller.removePageTranslationState(1);
	assert.equal(
		(
			await f.send("PREFETCH_YOUTUBE_SUBTITLES", {
				sessionId: f.session.sessionId,
			})
		).sessionStatus,
		"missing",
	);
});

test("session replacement and removal abort their signals", () => {
	const queue = TranslationSession.createPageTranslationQueue();
	const first = queue.create(1, {});
	const second = queue.create(1, {});
	assert.equal(first.signal.aborted, true);
	assert.equal(second.signal.aborted, false);
	queue.remove(1);
	assert.equal(second.signal.aborted, true);
});

test.each(["rejected", "ok-false", "no-ack"])(
	"failed subtitle delivery (%s) stays retryable; rendered zero completes the cue",
	async (failure) => {
		let rejectDelivery = true;
		const f = fixture({
			sendMessage: (message) => {
				if (
					message.type !==
						Messages.MESSAGE_TYPES.RENDER_PAGE_TRANSLATION_UPDATES ||
					!rejectDelivery
				)
					return undefined;
				if (failure === "rejected")
					return Promise.reject(new Error("Receiving end does not exist"));
				return Promise.resolve(
					failure === "ok-false" ? { ok: false } : undefined,
				);
			},
		});
		await f.send("QUEUE_PAGE_TRANSLATION_ITEMS", {
			sessionId: f.session.sessionId,
			items: [caption("cue")],
		});
		await flush();
		assert.equal(f.session.translatedIds.has("cue"), false);
		const clear = f.sent.find(
			(message) =>
				message.type === Messages.MESSAGE_TYPES.CLEAR_PAGE_PLACEHOLDERS,
		);
		assert.equal(clear.payload.sessionId, f.session.sessionId);
		assert.equal(clear.payload.retryable, true);
		assert.equal(clear.payload.reason, "api-error");
		rejectDelivery = false;
		assert.equal(
			(
				await f.send("QUEUE_PAGE_TRANSLATION_ITEMS", {
					sessionId: f.session.sessionId,
					items: [caption("cue")],
				})
			).queued,
			1,
		);
		await flush();
		assert.equal(f.session.translatedIds.has("cue"), true);
		const scoped = f.sent.filter((message) =>
			[
				Messages.MESSAGE_TYPES.RENDER_PAGE_TRANSLATION_UPDATES,
				Messages.MESSAGE_TYPES.RENDER_YOUTUBE_DIAGNOSTIC_EVENT,
			].includes(message.type),
		);
		assert.equal(
			scoped.every(
				(message) => message.payload.sessionId === f.session.sessionId,
			),
			true,
		);
	},
);

test("early subtitle setup rejection sends a non-retryable clear without placeholders", async () => {
	const f = fixture({
		request: async () => {
			throw new Error("model setup rejected");
		},
	});
	await f.send("QUEUE_PAGE_TRANSLATION_ITEMS", {
		sessionId: f.session.sessionId,
		items: [caption("cue")],
	});
	await flush();
	const clear = f.sent.find(
		(message) =>
			message.type === Messages.MESSAGE_TYPES.CLEAR_PAGE_PLACEHOLDERS,
	);
	assert.deepEqual(clear?.payload, {
		ids: ["cue"],
		sessionId: f.session.sessionId,
		retryable: false,
		reason: "setup-error",
	});
	assert.equal(f.session.inFlightCount, 0);
});

test("five stalled subtitle batches expire at thirty seconds and later work completes", async () => {
	vi.useFakeTimers();
	let stalled = true;
	const f = fixture({
		request: async (request) => {
			if (stalled) return new Promise(() => {});
			await request.onChunkResolved({
				translations: request.chunks
					.flat()
					.map((item) => ({ ...item, translation: "Done" })),
			});
			return { failures: [] };
		},
	});
	for (let i = 0; i < 5; i += 1)
		await f.send("QUEUE_PAGE_TRANSLATION_ITEMS", {
			sessionId: f.session.sessionId,
			items: [caption(`cue-${i}`)],
		});
	await flush();
	assert.equal(f.session.inFlightCount, 5);
	assert.equal(
		f.requests.every((request) => request.signal instanceof AbortSignal),
		true,
	);
	await vi.advanceTimersByTimeAsync(29999);
	assert.equal(f.session.inFlightCount, 5);
	await vi.advanceTimersByTimeAsync(1);
	await flush();
	assert.equal(f.session.inFlightCount, 0);
	assert.equal(
		f.requests.every((request) => request.signal.aborted),
		true,
	);
	const clears = f.sent.filter(
		(message) =>
			message.type === Messages.MESSAGE_TYPES.CLEAR_PAGE_PLACEHOLDERS,
	);
	assert.equal(clears.length, 5);
	assert.equal(
		clears.every(
			(message) =>
				message.payload.reason === "request-timeout" &&
				message.payload.retryable,
		),
		true,
	);
	stalled = false;
	await f.send("QUEUE_PAGE_TRANSLATION_ITEMS", {
		sessionId: f.session.sessionId,
		items: [caption("later")],
	});
	await flush();
	assert.equal(f.session.translatedIds.has("later"), true);
});

test("a hanging diagnostic cannot retain subtitle capacity", async () => {
	vi.useFakeTimers();
	const f = fixture({
		sendMessage: (message) =>
			message.type === Messages.MESSAGE_TYPES.RENDER_YOUTUBE_DIAGNOSTIC_EVENT
				? new Promise(() => {})
				: undefined,
	});
	await f.send("QUEUE_PAGE_TRANSLATION_ITEMS", {
		sessionId: f.session.sessionId,
		items: [caption("cue")],
	});
	await flush();
	await vi.advanceTimersByTimeAsync(30000);
	assert.equal(f.session.inFlightCount, 0);
	assert.equal(
		f.sent.some(
			(message) =>
				message.type === Messages.MESSAGE_TYPES.CLEAR_PAGE_PLACEHOLDERS,
		),
		true,
	);
});

test.each([true, false])(
	"late prefetch initialization (ok=%s) cannot replace or delete a newer session",
	async (ok) => {
		let resolveOld;
		const prefetch = createYoutubeCaptionPrefetch({
			fetch: (url) =>
				String(url).includes("old")
					? new Promise((resolve) => {
							resolveOld = resolve;
						})
					: Promise.resolve({
							ok: true,
							json: async () => ({
								events: [
									{
										tStartMs: 600000,
										dDurationMs: 1000,
										segs: [{ utf8: "Cue" }],
									},
								],
							}),
						}),
		});
		const old = prefetch.initialize({
			tabId: 1,
			sessionId: "old",
			baseUrl: "https://www.youtube.com/api/timedtext?v=old",
		});
		await prefetch.initialize({
			tabId: 1,
			sessionId: "new",
			baseUrl: "https://www.youtube.com/api/timedtext?v=new",
		});
		resolveOld({
			ok,
			json: async () => ({
				events: [
					{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Old cue" }] },
				],
			}),
		});
		await old;
		const result = await prefetch.update({
			tabId: 1,
			sessionId: "new",
			currentTimeMs: 600000,
		});
		assert.equal(result.available, true);
		assert.equal(result.sessionStatus, "active");
	},
);

test("recovery forwards startup identity and rejects another video without opening Settings", async () => {
	const f = fixture();
	const result = await f.send("START_YOUTUBE_SUBTITLE_TRANSLATION", {
		videoKey: "video-a",
		requestId: "attempt-a",
		recovery: true,
	});
	assert.equal(result.ok, true);
	assert.equal(typeof result.sessionId, "string");
	const start = f.sent.find(
		(message) =>
			message.type === Messages.MESSAGE_TYPES.START_PAGE_TRANSLATION_SESSION,
	);
	assert.equal(start.payload.youtubeVideoKey, "video-a");
	assert.equal(start.payload.youtubeRequestId, "attempt-a");
	const wrong = await f.send("START_YOUTUBE_SUBTITLE_TRANSLATION", {
		videoKey: "video-b",
		requestId: "attempt-b",
		recovery: true,
	});
	assert.equal(wrong.ok, false);
	assert.equal(f.chrome.runtime.openOptionsPage.mock.calls.length, 0);
});

test.each(["render", "clear"])(
	"a hanging %s endpoint cannot retain subtitle capacity",
	async (endpoint) => {
		vi.useFakeTimers();
		const f = fixture({
			sendMessage: (message) =>
				message.type ===
				Messages.MESSAGE_TYPES[
					endpoint === "render"
						? "RENDER_PAGE_TRANSLATION_UPDATES"
						: "CLEAR_PAGE_PLACEHOLDERS"
				]
					? new Promise(() => {})
					: undefined,
			request:
				endpoint === "clear"
					? async () => ({ failures: [{ chunkItems: [caption("cue")] }] })
					: undefined,
			getIncompleteSegmentIds: endpoint === "clear" ? () => ["cue"] : undefined,
		});
		await f.send("QUEUE_PAGE_TRANSLATION_ITEMS", {
			sessionId: f.session.sessionId,
			items: [caption("cue")],
		});
		await flush();
		await vi.advanceTimersByTimeAsync(30000);
		assert.equal(f.session.inFlightCount, 0);
		assert.equal(f.session.translatedIds.size, 0);
	},
);

test("late callbacks after timeout or session replacement cannot render or complete old cues", async () => {
	vi.useFakeTimers();
	const pending = [];
	const f = fixture({
		request: (request) =>
			new Promise((resolve) => pending.push({ request, resolve })),
	});
	await f.send("QUEUE_PAGE_TRANSLATION_ITEMS", {
		sessionId: f.session.sessionId,
		items: [caption("expired")],
	});
	await flush();
	await vi.advanceTimersByTimeAsync(30000);
	const expired = pending.shift();
	await expired.request.onChunkResolved({
		translations: [{ ...caption("expired"), translation: "Late" }],
	});
	expired.resolve({ failures: [] });
	await f.send("QUEUE_PAGE_TRANSLATION_ITEMS", {
		sessionId: f.session.sessionId,
		items: [caption("old")],
	});
	await flush();
	const old = pending.shift();
	const current = f.controller.pageTranslationQueue.create(
		1,
		f.session.settings,
	);
	await flush();
	assert.equal(old.request.signal.aborted, true);
	await old.request.onChunkResolved({
		translations: [{ ...caption("old"), translation: "Late" }],
	});
	old.resolve({ failures: [] });
	await flush();
	assert.equal(
		f.sent.some(
			(message) =>
				message.type === Messages.MESSAGE_TYPES.RENDER_PAGE_TRANSLATION_UPDATES,
		),
		false,
	);
	assert.equal(current.translatedIds.size, 0);
	assert.equal(f.session.translatedIds.size, 0);
});

test("a delayed response below the deadline is delivered and clears the timer", async () => {
	vi.useFakeTimers();
	const f = fixture({
		request: async (request) => {
			await new Promise((resolve) => setTimeout(resolve, 29000));
			await request.onChunkResolved({
				translations: [{ ...caption("cue"), translation: "Ready" }],
			});
			return { failures: [] };
		},
	});
	await f.send("QUEUE_PAGE_TRANSLATION_ITEMS", {
		sessionId: f.session.sessionId,
		items: [caption("cue")],
	});
	await flush();
	await vi.advanceTimersByTimeAsync(29000);
	assert.equal(f.session.translatedIds.has("cue"), true);
	assert.equal(f.session.inFlightCount, 0);
	await vi.advanceTimersByTimeAsync(1000);
	assert.equal(f.requests[0].signal.aborted, false);
	assert.equal(vi.getTimerCount(), 0);
});

test.each(["enable", "native", "fetch"])(
	"recovery bounds hanging %s acquisition and retains visible fallback",
	async (stage) => {
		vi.useFakeTimers();
		let probes = 0;
		const f = fixture({
			executeScript: () => {
				probes += 1;
				if (stage === "enable" || probes > 1) return new Promise(() => {});
				return Promise.resolve([
					{
						result: {
							enabled: true,
							currentTimeMs: 600000,
							playbackRate: 1,
							trackCandidates: {
								currentVideoId: "video-a",
								playerResponse: {
									videoId: "video-a",
									tracks: [
										{
											baseUrl:
												"https://www.youtube.com/api/timedtext?v=video-a&lang=en",
											languageCode: "en",
										},
									],
								},
							},
						},
					},
				]);
			},
			fetch: () => new Promise(() => {}),
		});
		if (stage === "fetch")
			f.chrome.scripting.executeScript = async () =>
				++probes === 1
					? [
							{
								result: {
									enabled: true,
									trackCandidates: {
										currentVideoId: "video-a",
										playerResponse: {
											videoId: "video-a",
											tracks: [
												{
													baseUrl:
														"https://www.youtube.com/api/timedtext?v=video-a&lang=en",
													languageCode: "en",
												},
											],
										},
									},
								},
							},
						]
					: [{ result: [] }];
		const operation = f.send("START_YOUTUBE_SUBTITLE_TRANSLATION", {
			videoKey: "video-a",
			requestId: stage,
			recovery: true,
		});
		await flush();
		await vi.advanceTimersByTimeAsync(30000);
		const result = await operation;
		assert.equal(result.ok, true);
		assert.equal(result.prefetch.available, false);
		assert.equal(
			f.controller.pageTranslationQueue.get(1, result.sessionId, 0)?.sessionId,
			result.sessionId,
		);
		assert.equal(vi.getTimerCount(), 0);
	},
);

test("recovery bounds credential setup and cannot start late after timeout", async () => {
	vi.useFakeTimers();
	let finish;
	const f = fixture({
		ProviderRuntime: {
			assertConfigured: () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		},
	});
	const operation = f.send("START_YOUTUBE_SUBTITLE_TRANSLATION", {
		videoKey: "video-a",
		requestId: "setup",
		recovery: true,
	});
	await flush();
	await vi.advanceTimersByTimeAsync(30000);
	assert.equal((await operation).ok, false);
	finish();
	await flush();
	assert.equal(
		f.sent.some(
			(message) =>
				message.type === Messages.MESSAGE_TYPES.START_PAGE_TRANSLATION_SESSION,
		),
		false,
	);
	assert.equal(f.chrome.runtime.openOptionsPage.mock.calls.length, 0);
});

test.each([
	{ complete: false },
	{ permission: false },
	{ settings: { disabledDomains: "youtube.com" } },
])(
	"recovery revalidates settings and permissions without interactive access: %j",
	async (options) => {
		const f = fixture(options);
		const result = await f.send("START_YOUTUBE_SUBTITLE_TRANSLATION", {
			videoKey: "video-a",
			requestId: "invalid",
			recovery: true,
		});
		assert.equal(result.ok, false);
		assert.equal(result.openOptions, false);
		assert.equal(result.retryable, false);
		assert.equal(f.chrome.permissions.request.mock.calls.length, 0);
		assert.equal(f.chrome.runtime.openOptionsPage.mock.calls.length, 0);
		assert.equal(
			f.sent.some(
				(message) =>
					message.type ===
					Messages.MESSAGE_TYPES.START_PAGE_TRANSLATION_SESSION,
			),
			false,
		);
	},
);

test("timed sessions stay active across empty windows and ten and twenty minute cues", async () => {
	const offered = [];
	const prefetch = createYoutubeCaptionPrefetch({
		enqueue: async ({ items }) => {
			offered.push(...items);
			return { queued: items.length, sessionStatus: "active" };
		},
		fetch: async () => ({
			ok: true,
			json: async () => ({
				events: [600000, 1200000].map((tStartMs) => ({
					tStartMs,
					dDurationMs: 1000,
					segs: [{ utf8: "Cue" }],
				})),
			}),
		}),
	});
	const context = {
		tabId: 1,
		sessionId: "long",
		baseUrl: "https://www.youtube.com/api/timedtext?v=long",
	};
	const initial = await prefetch.initialize(context);
	assert.deepEqual(initial, {
		available: true,
		cueCount: 2,
		queued: 0,
		sessionStatus: "active",
	});
	for (const currentTimeMs of [600000, 1200000]) {
		const result = await prefetch.update({ ...context, currentTimeMs });
		assert.equal(result.sessionStatus, "active");
		assert.equal(result.queued, 1);
	}
	assert.equal(offered.length, 2);
});

test("a superseded startup cannot delete or overwrite the newer accepted session", async () => {
	let release;
	let starts = 0;
	const f = fixture({
		sendMessage: (message) => {
			if (
				message.type ===
					Messages.MESSAGE_TYPES.START_PAGE_TRANSLATION_SESSION &&
				++starts === 1
			)
				return new Promise((resolve) => {
					release = resolve;
				});
			return undefined;
		},
	});
	const first = f.send("START_YOUTUBE_SUBTITLE_TRANSLATION", {
		videoKey: "video-a",
		requestId: "old",
		recovery: true,
	});
	await flush();
	assert.equal(typeof release, "function");
	const second = await f.send("START_YOUTUBE_SUBTITLE_TRANSLATION", {
		videoKey: "video-a",
		requestId: "new",
		recovery: true,
	});
	assert.equal(second.ok, true);
	assert.equal((await first).ok, false);
	release({ items: [caption("old")], keepAlive: true });
	await flush();
	assert.equal(
		f.controller.pageTranslationQueue.get(1, second.sessionId, 0)?.sessionId,
		second.sessionId,
	);
	assert.equal(f.requests.length, 0);
});

test.each(["rejected", "timeout"])(
	"an unaccepted startup (%s) leaves no ghost session",
	async (failure) => {
		vi.useFakeTimers();
		let release;
		const f = fixture({
			sendMessage: (message) => {
				if (
					message.type !== Messages.MESSAGE_TYPES.START_PAGE_TRANSLATION_SESSION
				)
					return undefined;
				return failure === "rejected"
					? Promise.resolve({ ok: false, items: [] })
					: new Promise((resolve) => {
							release = resolve;
						});
			},
		});
		const pending = f.send("START_YOUTUBE_SUBTITLE_TRANSLATION", {
			videoKey: "video-a",
			requestId: failure,
			recovery: true,
		});
		await flush();
		if (failure === "timeout") await vi.advanceTimersByTimeAsync(30000);
		const result = await pending;
		assert.equal(result.ok, false);
		assert.equal(
			result.reason,
			failure === "timeout" ? "request-timeout" : "setup-error",
		);
		assert.equal(f.controller.pageTranslationQueue.get(1), null);
		release?.({ items: [caption("late")], keepAlive: true });
		await flush();
		assert.equal(f.requests.length, 0);
		assert.equal(f.controller.pageTranslationQueue.get(1), null);
	},
);

test.each([
	{ error: new Error("transport rejected"), retryable: true },
	{
		error: Object.assign(new Error("private provider body"), { status: 401 }),
		retryable: false,
	},
	{
		error: Object.assign(new Error("private provider body"), {
			statusCode: 403,
		}),
		retryable: false,
	},
	{
		error: Object.assign(new Error("private provider body"), {
			name: "AuthenticationError",
		}),
		retryable: false,
	},
	{
		error: Object.assign(new Error("private provider body"), {
			code: "invalid_api_key",
		}),
		retryable: false,
	},
	{
		error: new Error(
			"The selected provider is not configured. Open Settings and add a credential.",
		),
		retryable: false,
	},
	{
		error: new Error("Selected model is unavailable: provider/model."),
		retryable: false,
	},
	{
		error: Object.assign(new Error("temporarily unavailable"), { status: 503 }),
		retryable: true,
	},
])(
	"transport and incomplete subtitle responses settle their source IDs (%j)",
	async ({ error, retryable }) => {
		const f = fixture({
			request: async () => ({
				failures: [
					{
						chunkItems: [caption("cue")],
						error,
					},
				],
			}),
			getIncompleteSegmentIds: () => ["cue"],
		});
		await f.send("QUEUE_PAGE_TRANSLATION_ITEMS", {
			sessionId: f.session.sessionId,
			items: [caption("cue")],
		});
		await flush();
		const clear = f.sent.find(
			(message) =>
				message.type === Messages.MESSAGE_TYPES.CLEAR_PAGE_PLACEHOLDERS,
		);
		assert.deepEqual(clear.payload, {
			ids: ["cue"],
			reason: retryable ? "api-error" : "setup-error",
			retryable,
			sessionId: f.session.sessionId,
		});
		assert.equal(f.session.inFlightCount, 0);
		assert.equal(f.session.translatedIds.size, 0);
		const diagnostics = f.sent.filter(
			(message) =>
				message.type === Messages.MESSAGE_TYPES.RENDER_YOUTUBE_DIAGNOSTIC_EVENT,
		);
		assert.doesNotMatch(
			JSON.stringify(diagnostics),
			/private provider body|provider\/model/u,
		);
	},
);
