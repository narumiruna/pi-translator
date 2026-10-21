import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

afterEach(() => vi.useRealTimers());

import { createContentRenderer } from "../src/content/rendering/runtime.js";
import * as YoutubeDiagnosticsApi from "../src/content/youtube/diagnostics.js";
import * as YoutubePlayerControlApi from "../src/content/youtube/player-control.js";
import { createYoutubeRuntime } from "../src/content/youtube/runtime.js";
import * as SubtitleApi from "../src/content/youtube/subtitles.js";
import * as TimedCaptionApi from "../src/content/youtube/timed-captions.js";
import * as Messages from "../src/shared/messages.js";

test("YouTube runtime coalesces progressive fallbacks and recovers caption timeouts", () => {
	const events = [];
	let scheduled = 0;
	let sourceId = "ot-a";
	let sourceText = "Build";
	const buttonAttributes = new Map([["data-state", "error"]]);
	const button = {
		disabled: false,
		setAttribute(name, value) {
			buttonAttributes.set(name, value);
		},
	};
	const source = {
		getAttribute(name) {
			return name === "data-ot-source-id" ? sourceId : null;
		},
		get textContent() {
			return sourceText;
		},
	};
	const video = { currentTime: 1.5, playbackRate: 1 };
	const document = {
		querySelector(selector) {
			return selector === "#movie_player video" ? video : null;
		},
		querySelectorAll(selector) {
			return selector === YoutubeDiagnosticsApi.CAPTION_SEGMENT_SELECTOR
				? [source]
				: [];
		},
	};
	const pageState = {
		pageTranslation: {},
		youtubeControl: {
			button,
			errorReason: "caption-timeout",
			state: "error",
		},
		youtubeDiagnostics: {
			captionTrace: YoutubeDiagnosticsApi.createCaptionTraceStore(),
			panel: null,
			status: "",
			store: {
				add(stage, detail) {
					events.push({ stage, detail });
				},
				getEvents() {
					return events;
				},
			},
		},
		youtubeSubtitleTranslations: new Map(),
	};
	const runtime = createYoutubeRuntime({
		chrome: { runtime: { getManifest: () => ({ version: "test" }) } },
		document,
		Messages,
		pageState,
		scheduleVisibleTranslation() {
			scheduled += 1;
		},
		SubtitleApi,
		TimedCaptionApi,
		window: { location: {} },
		YoutubeDiagnosticsApi,
		YoutubePlayerControlApi,
	});

	runtime.applyYoutubeControlState(button, "error");
	assert.equal(pageState.youtubeControl.errorReason, "caption-timeout");
	assert.deepEqual(
		runtime
			.matchYoutubeCaptionItems([
				{ id: "ot-a", kind: "subtitle", text: "Build" },
			])
			.missing.map((item) => item.id),
		["ot-a"],
	);
	assert.equal(buttonAttributes.get("data-state"), "active");
	assert.equal(pageState.youtubeControl.errorReason, "");

	sourceId = "ot-b";
	sourceText = "Build reliable";
	assert.deepEqual(
		runtime.matchYoutubeCaptionItems([
			{ id: "ot-b", kind: "subtitle", text: "Build reliable" },
		]).missing,
		[],
	);
	assert.deepEqual(runtime.settleYoutubeCaptionFallbacks([{ id: "ot-a" }]), {
		settledIds: new Set(["ot-a"]),
		supersededIds: new Set(["ot-a"]),
		supersededItems: new Map([
			["ot-a", { id: "ot-b", text: "Build reliable" }],
		]),
	});
	assert.equal(scheduled, 1);
	assert.deepEqual(
		runtime
			.matchYoutubeCaptionItems([
				{ id: "ot-b", kind: "subtitle", text: "Build reliable" },
			])
			.missing.map((item) => item.id),
		["ot-b"],
	);
	runtime.settleYoutubeCaptionFallbacks(["ot-b"]);
	sourceId = "ot-c";
	sourceText = "Build reliable tools";
	assert.deepEqual(
		runtime
			.matchYoutubeCaptionItems([
				{ id: "ot-c", kind: "subtitle", text: "Build reliable tools" },
			])
			.missing.map((item) => item.id),
		["ot-c"],
	);
	runtime.resetYoutubeCaptionFallbacks();
	sourceId = "ot-d";
	assert.deepEqual(
		runtime
			.matchYoutubeCaptionItems([
				{ id: "ot-d", kind: "subtitle", text: "Build reliable tools" },
			])
			.missing.map((item) => item.id),
		["ot-d"],
	);
	assert.ok(events.some((event) => event.stage === "fallback-coalesced"));
});

test("YouTube runtime does not recover non-timeout errors", () => {
	const button = { setAttribute() {} };
	const pageState = {
		pageTranslation: {},
		youtubeControl: { button, errorReason: "fatal", state: "error" },
		youtubeDiagnostics: { panel: null },
		youtubeSubtitleTranslations: new Map(),
	};
	const runtime = createYoutubeRuntime({
		chrome: { runtime: { getManifest: () => ({ version: "test" }) } },
		document: { querySelectorAll: () => [{ textContent: "Visible" }] },
		Messages,
		pageState,
		SubtitleApi,
		TimedCaptionApi,
		window: { location: {} },
		YoutubeDiagnosticsApi,
		YoutubePlayerControlApi,
	});

	assert.equal(runtime.recoverYoutubeCaptionTimeout(), false);
	assert.equal(pageState.youtubeControl.state, "error");
});

test("YouTube runtime reports rate-aware progress, seeks, and rate changes", () => {
	const listeners = new Map();
	const sent = [];
	const video = {
		currentTime: 5,
		playbackRate: 1.5,
		addEventListener(type, listener) {
			listeners.set(type, listener);
		},
		removeEventListener(type) {
			listeners.delete(type);
		},
	};
	const pageState = {
		pageTranslation: { sessionId: "session-1" },
		youtubeControl: {
			lastPrefetchTimeMs: 0,
			prefetchVideo: null,
		},
		youtubeDiagnostics: { panel: null },
		youtubeSubtitleTranslations: new Map(),
	};
	const runtime = createYoutubeRuntime({
		chrome: {
			runtime: {
				sendMessage(message) {
					sent.push(message);
					return Promise.resolve({ ok: true });
				},
			},
		},
		document: {
			querySelector(selector) {
				return selector.includes("video") ? video : null;
			},
		},
		Messages,
		pageState,
		SubtitleApi,
		TimedCaptionApi,
		window: {},
	});

	assert.equal(runtime.bindYoutubePrefetchTracking(), true);
	video.currentTime = 14;
	listeners.get("timeupdate")();
	assert.equal(sent.length, 0);
	video.currentTime = 15;
	listeners.get("timeupdate")();
	assert.deepEqual(
		sent.at(-1),
		Messages.prefetchYoutubeSubtitles({
			sessionId: "session-1",
			currentTimeMs: 15000,
			playbackRate: 1.5,
			reason: "progress",
		}),
	);
	video.currentTime = 42;
	listeners.get("seeking")();
	assert.deepEqual(
		sent.at(-1),
		Messages.prefetchYoutubeSubtitles({
			sessionId: "session-1",
			currentTimeMs: 42000,
			playbackRate: 1.5,
			reason: "seek",
		}),
	);
	video.playbackRate = 2;
	listeners.get("ratechange")();
	assert.deepEqual(
		sent.at(-1),
		Messages.prefetchYoutubeSubtitles({
			sessionId: "session-1",
			currentTimeMs: 42000,
			playbackRate: 2,
			reason: "ratechange",
		}),
	);
	runtime.cleanupYoutubeRuntime();
	assert.deepEqual([...listeners.keys()], []);
});

function recoveryFixture(
	sendMessage = async () => ({ ok: true, sessionId: "new-session" }),
	activeSiteProfile = { presentation: "subtitle" },
) {
	const events = [];
	const sent = [];
	const attributes = new Map([["data-ot-source-id", "source-1"]]);
	const source = {
		textContent: "Current caption",
		getAttribute: (name) => attributes.get(name),
		removeAttribute: (name) => attributes.delete(name),
	};
	function makeVideo() {
		const listeners = new Map();
		return {
			currentTime: 5,
			playbackRate: 1,
			listeners,
			addEventListener: (name, callback) => listeners.set(name, callback),
			removeEventListener: (name) => listeners.delete(name),
		};
	}
	let video = makeVideo();
	const location = {
		hostname: "www.youtube.com",
		pathname: "/watch",
		search: "?v=video-a",
	};
	const pageState = {
		debug: { enabled: false },
		pageTranslation: { active: true, sessionId: "old-session" },
		youtubeControl: {
			state: "active",
			videoKey: "video-a",
			button: { setAttribute() {} },
		},
		youtubeDiagnostics: {
			store: YoutubeDiagnosticsApi.createDiagnosticStore(),
			captionTrace: YoutubeDiagnosticsApi.createCaptionTraceStore(),
		},
		youtubeSubtitleTranslations: new Map(),
	};
	let scheduled = 0;
	const runtime = createYoutubeRuntime({
		document: {
			querySelector: (selector) => (selector.includes("video") ? video : null),
			querySelectorAll: (selector) =>
				selector.includes(".ytp-caption-segment") ? [source] : [],
		},
		window: {
			location,
			setTimeout,
			clearTimeout,
		},
		chrome: {
			runtime: {
				sendMessage(message) {
					sent.push(message);
					return sendMessage(message);
				},
			},
		},
		pageState,
		Messages,
		SubtitleApi,
		TimedCaptionApi,
		YoutubeDiagnosticsApi,
		YoutubePlayerControlApi,
		ensureStyles() {},
		activeSiteProfile,
		scheduleVisibleTranslation() {
			scheduled++;
		},
	});
	return {
		runtime,
		pageState,
		sent,
		source,
		attributes,
		events,
		location,
		getScheduled: () => scheduled,
		getVideo: () => video,
		replaceVideo: () => {
			video = makeVideo();
			return video;
		},
	};
}

test("queue session loss and progress loss share one recovery and restore visible-only tracking", async () => {
	let finish;
	const f = recoveryFixture((message) =>
		message.type === Messages.MESSAGE_TYPES.START_YOUTUBE_SUBTITLE_TRANSLATION
			? new Promise((resolve) => {
					finish = resolve;
				})
			: Promise.resolve({ available: false, sessionStatus: "missing" }),
	);
	f.runtime.matchYoutubeCaptionItems([
		{ id: "source-1", text: "Current caption" },
	]);
	f.attributes.set("data-translated", "true");
	f.attributes.set("data-ot-translated", "true");
	f.attributes.set("data-ot-source-stale", "true");
	f.runtime.bindYoutubePrefetchTracking();
	f.runtime.handleYoutubeQueueResult(
		[{ id: "source-1" }],
		{ ok: true, queued: 0, sessionStatus: "missing" },
		"old-session",
	);
	f.runtime.handleYoutubeSessionLoss();
	await Promise.resolve();
	assert.equal(
		f.sent.filter(
			(message) =>
				message.type ===
				Messages.MESSAGE_TYPES.START_YOUTUBE_SUBTITLE_TRANSLATION,
		).length,
		1,
	);
	assert.equal(f.runtime.canQueueYoutubeCaptions(), false);
	assert.equal(f.attributes.has("data-translated"), false);
	assert.equal(f.attributes.has("data-ot-translated"), false);
	assert.equal(f.attributes.has("data-ot-source-stale"), false);
	finish({
		ok: true,
		sessionId: "new-session",
		prefetch: { available: false },
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.pageState.pageTranslation.sessionId, "new-session");
	assert.equal(f.runtime.canQueueYoutubeCaptions(), true);
	assert.equal(f.pageState.youtubeControl.prefetchVideo, f.getVideo());
	assert.equal(
		f.runtime.matchYoutubeCaptionItems([
			{ id: "source-1", text: "Current caption" },
		]).missing.length,
		1,
	);
	assert.equal(
		f.runtime.acceptsYoutubeSessionPayload({ sessionId: "old-session" }),
		false,
	);
	assert.equal(
		f.runtime.acceptsYoutubeSessionPayload({ sessionId: "new-session" }),
		true,
	);
	f.runtime.cleanupYoutubeRuntime();
});

test("initial extraction registers fallback before enqueue so a static failed cue retries", async () => {
	vi.useFakeTimers();
	const f = recoveryFixture();
	const item = { id: "source-1", kind: "subtitle", text: "Current caption" };
	const renderer = createContentRenderer({
		document: { querySelectorAll: () => [], querySelector: () => null },
		window: {},
		pageState: f.pageState,
		activeSiteProfile: { presentation: "subtitle" },
		SubtitleApi,
		ensureStyles() {},
		ensureObserver() {},
		withObserverPaused: (callback) => callback(),
		collectPageItems: () => ({
			items: [item],
			totalSegments: 1,
			keepAlive: true,
		}),
		activatePageTranslationSession(sessionId) {
			f.pageState.pageTranslation.active = true;
			f.pageState.pageTranslation.sessionId = sessionId;
		},
		applyYoutubeControlState: f.runtime.applyYoutubeControlState,
		recordYoutubeDiagnostic: f.runtime.recordYoutubeDiagnostic,
		resetYoutubeCaptionFallbacks: f.runtime.resetYoutubeCaptionFallbacks,
		failYoutubeCaptionFallbacks: f.runtime.failYoutubeCaptionFallbacks,
		matchYoutubeCaptionItems: f.runtime.matchYoutubeCaptionItems,
		isDebugInfoEnabled: () => false,
	});
	assert.equal(
		renderer.startPageTranslationSession({ sessionId: "session-1" }).items
			.length,
		1,
	);
	assert.equal(f.runtime.matchYoutubeCaptionItems([item]).missing.length, 0);
	renderer.clearPagePlaceholders({
		ids: [item.id],
		retryable: true,
		reason: "request-timeout",
	});
	await vi.advanceTimersByTimeAsync(1000);
	assert.equal(f.getScheduled(), 1);
	assert.equal(f.runtime.matchYoutubeCaptionItems([item]).missing.length, 1);
	f.runtime.cleanupYoutubeRuntime();
});

test("cleanup remains safe when Chrome invalidates the extension context synchronously", () => {
	const f = recoveryFixture(() => {
		throw new Error("Extension context invalidated");
	});
	assert.doesNotThrow(() => f.runtime.cleanupYoutubeRuntime());
});

test("cleanup on a non-YouTube watch URL cannot cancel a generic page session", () => {
	const f = recoveryFixture(undefined, { presentation: "inline" });
	f.location.hostname = "example.com";
	f.runtime.cleanupYoutubeRuntime();
	assert.equal(f.sent.length, 0);
});

test("leaving a watch URL for the YouTube home page still cancels the old video session", () => {
	const f = recoveryFixture();
	f.location.pathname = "/";
	f.location.search = "";
	f.runtime.cleanupYoutubeRuntime();
	assert.equal(
		f.sent.at(-1).type,
		Messages.MESSAGE_TYPES.CANCEL_YOUTUBE_SUBTITLE_TRANSLATION,
	);
	assert.equal(f.sent.at(-1).payload.sessionId, "old-session");
});

test("navigation before control mount rejects old queue and playback responses", async () => {
	const f = recoveryFixture();
	f.runtime.bindYoutubePrefetchTracking();
	f.location.search = "?v=video-b";
	f.runtime.handleYoutubeQueueResult(
		[{ id: "source-1" }],
		{ ok: true, sessionStatus: "missing" },
		"old-session",
	);
	f.runtime.handleYoutubeSessionLoss();
	f.getVideo().listeners.get("playing")();
	await Promise.resolve();
	assert.equal(f.sent.length, 0);
	assert.equal(
		f.runtime.acceptsYoutubeSessionPayload({ sessionId: "old-session" }),
		false,
	);
	f.runtime.cleanupYoutubeRuntime();
});

test("recovery retires old messages before START and accepts the new session before acquisition finishes", async () => {
	let finish;
	const f = recoveryFixture((message) =>
		message.type === Messages.MESSAGE_TYPES.START_YOUTUBE_SUBTITLE_TRANSLATION
			? new Promise((resolve) => {
					finish = resolve;
				})
			: Promise.resolve({ sessionStatus: "active", available: false }),
	);
	f.runtime.handleYoutubeSessionLoss();
	await Promise.resolve();
	assert.equal(f.pageState.pageTranslation.sessionId, "");
	assert.equal(
		f.runtime.acceptsYoutubeSessionPayload({ sessionId: "old-session" }),
		false,
	);
	const request = f.sent[0].payload;
	assert.equal(
		f.runtime.acceptsYoutubeStartup({
			youtubeVideoKey: "video-a",
			youtubeRequestId: request.requestId,
		}),
		true,
	);
	f.pageState.pageTranslation.sessionId = "new-session";
	assert.equal(
		f.runtime.acceptsYoutubeSessionPayload({ sessionId: "new-session" }),
		true,
	);
	f.getVideo().currentTime = 42;
	f.getVideo().playbackRate = 2;
	finish({ ok: true, sessionId: "new-session" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.sent.at(-1).payload.currentTimeMs, 42000);
	assert.equal(f.sent.at(-1).payload.playbackRate, 2);
	assert.equal(f.sent.at(-1).payload.reason, "seek");
	f.runtime.cleanupYoutubeRuntime();
});

test("fatal failure during startup cannot be replaced by a late success", async () => {
	let finish;
	const f = recoveryFixture(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	f.runtime.handleYoutubeSessionLoss();
	await Promise.resolve();
	f.runtime.failYoutubeCaptionFallbacks({
		ids: ["source-1"],
		retryable: false,
		reason: "setup-error",
	});
	finish({ ok: true, sessionId: "late-session" });
	await new Promise((resolve) => setImmediate(resolve));
	f.runtime.recordYoutubeDiagnostic("render", "Late delivery", {
		outcomes: { delivered: 1 },
	});
	assert.equal(f.pageState.pageTranslation.active, false);
	assert.equal(f.pageState.youtubeControl.state, "error");
	assert.equal(f.pageState.youtubeControl.prefetchVideo, null);
	assert.equal(f.pageState.pageTranslation.sessionId, "");
	f.runtime.cleanupYoutubeRuntime();
});

test("exhausted recovery stops playback status checks and leaves a retryable control", async () => {
	vi.useFakeTimers();
	const f = recoveryFixture(async () => ({ ok: false, retryable: true }));
	f.runtime.bindYoutubePrefetchTracking();
	f.runtime.handleYoutubeSessionLoss();
	await vi.advanceTimersByTimeAsync(20000);
	assert.equal(f.pageState.pageTranslation.active, false);
	assert.equal(f.pageState.youtubeControl.state, "error");
	assert.equal(f.getVideo().listeners.size, 0);
	assert.equal(
		f.sent.filter(
			(message) =>
				message.type ===
				Messages.MESSAGE_TYPES.START_YOUTUBE_SUBTITLE_TRANSLATION,
		).length,
		3,
	);
	assert.equal(
		f.sent.at(-1).type,
		Messages.MESSAGE_TYPES.CANCEL_YOUTUBE_SUBTITLE_TRANSLATION,
	);
	await vi.advanceTimersByTimeAsync(60000);
	assert.equal(f.sent.length, 4);
	f.runtime.cleanupYoutubeRuntime();
});

test("video replacement rebinds once and removes all old playback listeners", () => {
	const f = recoveryFixture();
	f.runtime.bindYoutubePrefetchTracking();
	const original = f.getVideo();
	const originalHandler = original.listeners.get("timeupdate");
	f.runtime.bindYoutubePrefetchTracking();
	assert.equal(original.listeners.get("timeupdate"), originalHandler);
	const replacement = f.replaceVideo();
	f.runtime.bindYoutubePrefetchTracking();
	assert.equal(original.listeners.size, 0);
	assert.equal(replacement.listeners.size, 4);
	assert.equal(f.sent.at(-1).payload.reason, "seek");
	assert.ok(
		f.pageState.youtubeDiagnostics.store
			.getEvents()
			.some((event) => event.stage === "player-rebound"),
	);
	f.runtime.cleanupYoutubeRuntime();
});

test("messaging rejection releases fallback and retries a snapshot only once", async () => {
	vi.useFakeTimers();
	const f = recoveryFixture();
	const item = { id: "source-1", text: "Current caption" };
	assert.equal(f.runtime.matchYoutubeCaptionItems([item]).missing.length, 1);
	f.runtime.handleYoutubeQueueResult([item], { ok: false }, "old-session");
	await vi.advanceTimersByTimeAsync(1000);
	assert.equal(f.getScheduled(), 1);
	assert.equal(f.runtime.matchYoutubeCaptionItems([item]).missing.length, 1);
	f.runtime.failYoutubeCaptionFallbacks({
		ids: [item.id],
		retryable: true,
		reason: "request-timeout",
	});
	await vi.advanceTimersByTimeAsync(10000);
	assert.equal(f.getScheduled(), 1);
	assert.equal(f.runtime.matchYoutubeCaptionItems([item]).missing.length, 0);
	assert.equal(f.pageState.youtubeControl.state, "error");
	f.runtime.cleanupYoutubeRuntime();
});

test("fatal setup failure stops automatic fallback while old-session rejection cannot settle current work", () => {
	const f = recoveryFixture();
	const item = { id: "source-1", text: "Current caption" };
	f.runtime.matchYoutubeCaptionItems([item]);
	f.runtime.handleYoutubeQueueResult([item], { ok: false }, "older-session");
	assert.equal(f.runtime.matchYoutubeCaptionItems([item]).missing.length, 0);
	f.runtime.failYoutubeCaptionFallbacks({
		ids: [item.id],
		retryable: false,
		reason: "setup-error",
	});
	assert.equal(f.pageState.pageTranslation.active, false);
	assert.equal(f.pageState.youtubeControl.state, "error");
	assert.equal(
		f.runtime.acceptsYoutubeSessionPayload({ sessionId: "old-session" }),
		false,
	);
	assert.ok(
		f.pageState.youtubeDiagnostics.store
			.getEvents()
			.some((event) => event.stage === "setup-error"),
	);
	f.runtime.cleanupYoutubeRuntime();
});
