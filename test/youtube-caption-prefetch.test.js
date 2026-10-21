import assert from "node:assert/strict";
import { test } from "vitest";

import { createYoutubeCaptionPrefetch } from "../src/background/youtube-caption-prefetch.js";

function createFixture() {
	const acceptedIds = new Set();
	const enqueued = [];
	const diagnostics = [];
	const fetches = [];
	const payload = {
		events: [
			{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Zero" }] },
			{ tStartMs: 30000, dDurationMs: 1000, segs: [{ utf8: "Thirty" }] },
			{ tStartMs: 59999, dDurationMs: 1000, segs: [{ utf8: "Sixty" }] },
			{ tStartMs: 60000, dDurationMs: 1000, segs: [{ utf8: "Boundary" }] },
			{ tStartMs: 90000, dDurationMs: 1000, segs: [{ utf8: "Ninety" }] },
			{ tStartMs: 119999, dDurationMs: 1000, segs: [{ utf8: "One twenty" }] },
			{
				tStartMs: 120000,
				dDurationMs: 1000,
				segs: [{ utf8: "Two minute boundary" }],
			},
			{
				tStartMs: 179999,
				dDurationMs: 1000,
				segs: [{ utf8: "Three minutes" }],
			},
		],
	};
	const prefetch = createYoutubeCaptionPrefetch({
		async enqueue(context) {
			enqueued.push(context);
			const accepted = context.items.filter(
				(item) => !acceptedIds.has(item.id),
			);

			for (const item of accepted) {
				acceptedIds.add(item.id);
			}
			return { queued: accepted.length };
		},
		async fetch(url, init) {
			fetches.push({ init, url });
			return {
				ok: true,
				async json() {
					return payload;
				},
			};
		},
		onDiagnostic(stage, detail) {
			diagnostics.push({ stage, detail });
		},
	});

	return { diagnostics, enqueued, fetches, prefetch };
}

test("initialization fetches JSON3 and queues the current 60-second window", async () => {
	const { diagnostics, enqueued, fetches, prefetch } = createFixture();

	assert.deepEqual(
		await prefetch.initialize({
			baseUrl: "https://www.youtube.com/api/timedtext?v=abc",
			currentTimeMs: 0,
			frameId: 0,
			sessionId: "session-1",
			tabId: 7,
		}),
		{ available: true, cueCount: 8, queued: 3, sessionStatus: "active" },
	);
	assert.equal(new URL(fetches[0].url).searchParams.get("fmt"), "json3");
	assert.deepEqual(fetches[0].init, { credentials: "include" });
	assert.match(enqueued[0].items[0].id, /^youtube-cue-0-0$/u);
	assert.deepEqual(
		enqueued[0].items.map((item) => item.text),
		["Zero", "Thirty", "Sixty"],
	);
	assert.equal(enqueued[0].placement, "front");
	assert.equal(enqueued[0].windowMs, 60000);
	assert.deepEqual(diagnostics.at(-2), {
		stage: "prefetch-window",
		detail: "rate=1; window=60000ms; placement=front; cues=3; queued=3",
	});
	assert.equal(diagnostics.at(-1).stage, "prefetch-ready");
});

test("playback rate expands the media window while preserving a bounded lead", async () => {
	for (const [playbackRate, expectedTexts, expectedWindowMs] of [
		[1, ["Zero", "Thirty", "Sixty"], 60000],
		[1.5, ["Zero", "Thirty", "Sixty", "Boundary"], 90000],
		[
			2,
			["Zero", "Thirty", "Sixty", "Boundary", "Ninety", "One twenty"],
			120000,
		],
		["fast", ["Zero", "Thirty", "Sixty"], 60000],
	]) {
		const { enqueued, prefetch } = createFixture();

		await prefetch.initialize({
			baseUrl: "https://www.youtube.com/api/timedtext?v=rate",
			currentTimeMs: 0,
			playbackRate,
			sessionId: `session-${playbackRate}`,
			tabId: 7,
		});
		assert.deepEqual(
			enqueued[0].items.map((item) => item.text),
			expectedTexts,
		);
		assert.equal(enqueued[0].windowMs, expectedWindowMs);
	}
});

test("progress refills an overlapping window without duplicate cue IDs", async () => {
	const { enqueued, prefetch } = createFixture();

	await prefetch.initialize({
		baseUrl: "https://www.youtube.com/api/timedtext?v=abc",
		currentTimeMs: 0,
		frameId: 0,
		sessionId: "session-1",
		tabId: 7,
	});
	assert.deepEqual(
		await prefetch.update({
			currentTimeMs: 30001,
			sessionId: "session-1",
			tabId: 7,
		}),
		{ available: true, queued: 2, sessionStatus: "active" },
	);
	assert.deepEqual(
		enqueued[1].items.map((item) => item.text),
		["Thirty", "Sixty", "Boundary", "Ninety"],
	);
	assert.equal(enqueued[1].placement, "back");
	assert.deepEqual(
		await prefetch.update({
			currentTimeMs: 31000,
			sessionId: "session-1",
			tabId: 7,
		}),
		{ available: true, queued: 0, sessionStatus: "active" },
	);
});

test("prefetch queues every overlapping active cue for exact DOM matching", async () => {
	const enqueued = [];
	const prefetch = createYoutubeCaptionPrefetch({
		async enqueue(context) {
			enqueued.push(context);
			return { queued: context.items.length };
		},
		async fetch() {
			return {
				ok: true,
				async json() {
					return {
						events: [
							{
								tStartMs: 1000,
								dDurationMs: 5000,
								segs: [{ utf8: "First active line" }],
							},
							{
								tStartMs: 3000,
								dDurationMs: 4000,
								segs: [{ utf8: "Second active line" }],
							},
						],
					};
				},
			};
		},
	});

	assert.deepEqual(
		await prefetch.initialize({
			baseUrl: "https://www.youtube.com/api/timedtext?v=overlap",
			currentTimeMs: 4000,
			sessionId: "session-overlap",
			tabId: 9,
		}),
		{ available: true, cueCount: 2, queued: 2, sessionStatus: "active" },
	);
	assert.deepEqual(
		enqueued[0].items.map((item) => item.text),
		["First active line", "Second active line"],
	);
});

test("seek windows return to the front of the queue", async () => {
	const { enqueued, prefetch } = createFixture();

	await prefetch.initialize({
		baseUrl: "https://www.youtube.com/api/timedtext?v=seek",
		currentTimeMs: 0,
		sessionId: "session-seek",
		tabId: 7,
	});
	await prefetch.update({
		currentTimeMs: 90000,
		reason: "seek",
		sessionId: "session-seek",
		tabId: 7,
	});

	assert.equal(enqueued[1].placement, "front");
});

test("a later refill can offer failed timed cues again", async () => {
	const enqueued = [];
	const prefetch = createYoutubeCaptionPrefetch({
		async enqueue(context) {
			enqueued.push(context);
			return { queued: context.items.length };
		},
		async fetch() {
			return {
				ok: true,
				async json() {
					return {
						events: [
							{
								tStartMs: 1000,
								dDurationMs: 1000,
								segs: [{ utf8: "Retry me" }],
							},
						],
					};
				},
			};
		},
	});

	await prefetch.initialize({
		baseUrl: "https://www.youtube.com/api/timedtext?v=retry",
		currentTimeMs: 0,
		sessionId: "session-retry",
		tabId: 7,
	});
	assert.deepEqual(
		await prefetch.update({
			currentTimeMs: 0,
			reason: "progress",
			sessionId: "session-retry",
			tabId: 7,
		}),
		{ available: true, queued: 1, sessionStatus: "active" },
	);
	assert.equal(enqueued.length, 2);
	assert.equal(enqueued[1].items[0].id, enqueued[0].items[0].id);
});

test("unavailable or malformed timed captions preserve fallback behavior", async () => {
	const diagnostics = [];
	const prefetch = createYoutubeCaptionPrefetch({
		async fetch() {
			throw new Error("timed text unavailable");
		},
		onDiagnostic(stage, detail) {
			diagnostics.push({ stage, detail });
		},
	});

	assert.deepEqual(
		await prefetch.initialize({
			baseUrl: "https://www.youtube.com/api/timedtext?v=abc",
			currentTimeMs: 0,
			sessionId: "session-1",
			tabId: 7,
		}),
		{ available: false, cueCount: 0, queued: 0, sessionStatus: "active" },
	);
	assert.equal(diagnostics.at(-1).stage, "prefetch-fallback");
	assert.deepEqual(
		await prefetch.initialize({
			baseUrl: "https://attacker.example/timedtext",
			currentTimeMs: 0,
			sessionId: "session-2",
			tabId: 7,
		}),
		{ available: false, cueCount: 0, queued: 0, sessionStatus: "active" },
	);
	assert.equal(diagnostics.length, 2);
	assert.deepEqual(diagnostics.at(-1), {
		detail:
			"Timed caption URL was missing or untrusted; using visible captions",
		stage: "prefetch-fallback",
	});
	assert.doesNotMatch(JSON.stringify(diagnostics), /attacker\.example/u);
});
