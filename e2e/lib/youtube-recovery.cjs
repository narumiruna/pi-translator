const assert = require("node:assert/strict");
const {
	saveOptions,
	takeScreenshot,
	waitFor,
} = require("./extension-test-helpers.cjs");
const {
	createWorkerStopper,
	getExtensionWorker,
	observeContentMessages,
} = require("./youtube-fixture.cjs");

const START = "start-youtube-subtitle-translation";
const PROGRESS = "prefetch-youtube-subtitles";
const QUEUE = "queue-page-translation-items";

async function runYoutubeRecoveryCases(options) {
	const {
		context,
		extensionId,
		config,
		mockApiServer,
		installCaptionFixture,
		installCaptionTrackMetadata,
		waitForCaptionTranslation,
		longCaptions,
	} = options;
	let serial = 0;
	const unique = (label) => `${label} ${Date.now()} ${serial++}.`;

	async function openCase({
		timedTrack = false,
		mode = "translation-only",
	} = {}) {
		await saveOptions(context, extensionId, config, {
			runConnectionTest: false,
			youtubeSubtitleDisplayMode: mode,
		});
		const page = await context.newPage();
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto(`https://www.youtube.com/watch?v=recovery${serial++}`, {
			waitUntil: "domcontentloaded",
		});
		await installCaptionTrackMetadata(page, { timedTrack });
		const control = page.locator("[data-ot-youtube-control]");
		await control.waitFor();
		const observer = await observeContentMessages(context, page, extensionId);
		const stopper = await createWorkerStopper(context, page, extensionId);
		const text = unique("Recovery baseline caption");
		await installCaptionFixture(page, text);
		await control.click();
		await waitForCaptionTranslation(page, text);
		await waitFor(
			async () => (await control.getAttribute("data-state")) === "active",
		);
		const starts = () =>
			observer
				.messages()
				.then((messages) =>
					messages.filter((entry) => entry.message.type === START),
				);
		const initial = (await starts()).at(-1).response;
		assert.ok(
			initial.sessionId,
			"Packaged startup must return its session identity.",
		);
		const send = (type, payload) =>
			observer.evaluate((message) => chrome.runtime.sendMessage(message), {
				type,
				payload,
			});
		return {
			page,
			control,
			observer,
			stopper,
			starts,
			send,
			initial,
			async close() {
				await observer.close();
				await stopper.close();
				await page.close();
			},
		};
	}

	async function captureEvidence(page, fileName) {
		await page
			.locator('[data-ot-role="youtube-diagnostics"]')
			.getByRole("button", { name: "Close", exact: true })
			.click();
		await takeScreenshot(page, config.artifactsDir, fileName, false);
	}

	async function nativeReadable(page, text) {
		const source = page
			.locator(".ytp-caption-segment")
			.filter({ hasText: text });
		assert.equal(await source.textContent(), text);
		assert.notEqual(
			await source.evaluate((node) => getComputedStyle(node).display),
			"none",
			"Native captions must remain readable without a current translation.",
		);
	}

	// Four actual stops: timed and visible-only, during playback and after a
	// wall-clock pause greater than Chrome's normal 30-second idle threshold.
	for (const timedTrack of [true, false]) {
		for (const paused of [false, true]) {
			const mode = paused ? "bilingual" : "translation-only";
			const test = await openCase({ timedTrack, mode });
			try {
				await test.page.evaluate(() => document.querySelector("video").play());
				if (paused) {
					await test.page.evaluate(() =>
						document.querySelector("video").pause(),
					);
					await test.page.waitForTimeout(31000);
				}
				const checkRestart = await test.stopper.stop();
				const missing = await test.send(PROGRESS, {
					sessionId: test.initial.sessionId,
					currentTimeMs: 0,
				});
				assert.equal(missing.sessionStatus, "missing");
				const count = (await test.starts()).length;
				await test.page.evaluate((resume) => {
					const video = document.querySelector("video");
					if (resume) video.play();
					else video.advanceTime(11);
				}, paused);
				await waitFor(async () => (await test.starts()).length > count, {
					timeoutMs: 15000,
					timeoutMessage: `Worker loss did not restart ${timedTrack ? "timed" : "visible-only"} captions (${paused ? "resumed" : "playing"}).`,
				});
				await checkRestart();
				await waitFor(
					async () => (await test.starts()).at(-1)?.response?.ok === true,
				);
				const recovered = (await test.starts()).at(-1).response;
				assert.notEqual(recovered.sessionId, test.initial.sessionId);
				assert.equal(recovered.prefetch.available, timedTrack);
				const stale = await test.send(QUEUE, {
					sessionId: test.initial.sessionId,
					items: [],
				});
				assert.equal(stale.sessionStatus, "stale");
				const active = await test.send(PROGRESS, {
					sessionId: recovered.sessionId,
					currentTimeMs: 11000,
				});
				assert.equal(active.sessionStatus, "active");
				const caption = unique("Caption after actual worker restart");
				await installCaptionFixture(test.page, caption);
				await nativeReadable(test.page, caption);
				const note = await waitForCaptionTranslation(test.page, caption);
				assert.equal(
					await note.getAttribute("data-ot-subtitle-display-mode"),
					mode,
				);
				if (mode === "bilingual") await nativeReadable(test.page, caption);
				assert.equal(
					(await test.starts()).length,
					count + 1,
					"Simultaneous loss reports must share one restart.",
				);
				await captureEvidence(
					test.page,
					`youtube-recovery-${timedTrack ? "timed" : "visible"}-${mode}.png`,
				);
				console.log(
					`Actual worker restart passed: ${timedTrack ? "timed" : "visible-only"}, ${paused ? "31-second pause/resume" : "playing"}, ${mode}.`,
				);
			} finally {
				await test.close();
			}
		}
	}

	// Listener rebinding and long media time are deterministic, not a real-time soak.
	const replacement = await openCase({ timedTrack: true });
	try {
		await replacement.page.evaluate(() => {
			window.__oldVideo = document.querySelector("video");
			const video = document.createElement("video");
			window.__fixtureInstallVideo(video);
			window.__oldVideo.replaceWith(video);
		});
		await waitFor(async () =>
			/player-rebound/.test(
				await replacement.page
					.locator('[data-ot-role="youtube-diagnostics"]')
					.textContent(),
			),
		);
		let before = (await replacement.observer.messages()).filter(
			(entry) => entry.message.type === PROGRESS,
		).length;
		await replacement.page.evaluate(() => {
			window.__oldVideo.currentTime = 100;
			window.__oldVideo.playbackRate = 2;
			window.__oldVideo.advanceTime(120);
		});
		await replacement.page.waitForTimeout(100);
		assert.equal(
			(await replacement.observer.messages()).filter(
				(entry) => entry.message.type === PROGRESS,
			).length,
			before,
			"Detached video listeners must be removed.",
		);
		for (const reason of ["seek", "ratechange", "progress"]) {
			before = (await replacement.observer.messages()).filter(
				(entry) => entry.message.type === PROGRESS,
			).length;
			await replacement.page.evaluate((event) => {
				const video = document.querySelector("video");
				if (event === "seek") video.currentTime = 50;
				if (event === "ratechange") video.playbackRate = 2;
				if (event === "progress") video.advanceTime(70);
			}, reason);
			await replacement.page.waitForTimeout(100);
			const added = (await replacement.observer.messages())
				.filter((entry) => entry.message.type === PROGRESS)
				.slice(before);
			assert.equal(
				added.length,
				1,
				`Replacement ${reason} must be sent exactly once.`,
			);
			assert.equal(added[0].message.payload.reason, reason);
		}
		assert.equal(
			(await replacement.starts()).length,
			1,
			"Node replacement must not restart a healthy session.",
		);
		for (const [index, caption] of longCaptions.entries()) {
			const timeMs = (index + 1) * 600000;
			await replacement.page.evaluate((time) => {
				document.querySelector("video").currentTime = time / 1000;
			}, timeMs);
			await waitFor(() =>
				mockApiServer
					.getResponseItemIds()
					.some((id) => id.startsWith(`youtube-cue-${timeMs}-`)),
			);
			await waitFor(() => mockApiServer.getActiveResponseCount() === 0);
			await installCaptionFixture(replacement.page, caption);
			await waitForCaptionTranslation(replacement.page, caption);
		}
		await captureEvidence(
			replacement.page,
			"youtube-recovery-twenty-minute-cue.png",
		);
	} finally {
		await replacement.close();
	}

	// Block all five real API connections after SSE headers. The production
	// 30-second deadline must close them and permit later captions to complete.
	const stalled = await openCase();
	try {
		await waitFor(() => mockApiServer.getActiveResponseCount() === 0);
		const abortsBefore = mockApiServer.getAbortedResponseCount();
		const requestsBefore = mockApiServer.getResponseRequestCount();
		mockApiServer.stallNextResponses(5);
		const queued = await stalled.send(QUEUE, {
			sessionId: stalled.initial.sessionId,
			items: Array.from({ length: 48 }, (_, index) => ({
				id: `stall-${serial}-${index}`,
				kind: "subtitle",
				text: unique(`Stalled batch caption ${index}`),
			})),
		});
		assert.equal(queued.sessionStatus, "active");
		await waitFor(() => mockApiServer.getActiveResponseCount() === 5);
		assert.equal(mockApiServer.getResponseRequestCount() - requestsBefore, 5);
		const caption = unique("Readable caption waiting for free capacity");
		await installCaptionFixture(stalled.page, caption);
		await nativeReadable(stalled.page, caption);
		await waitFor(
			() => mockApiServer.getAbortedResponseCount() >= abortsBefore + 5,
			{
				timeoutMs: 35000,
				timeoutMessage:
					"The production deadline did not abort all five real headers-only SSE connections.",
			},
		);
		const records = mockApiServer
			.getRequests()
			.filter((record) => record.stalled)
			.slice(-5);
		for (const record of records) {
			assert.ok(
				record.finishedAt - record.startedAt >= 28000,
				"Do not substitute a short test timeout for the production deadline.",
			);
			assert.ok(
				record.finishedAt - record.startedAt < 34000,
				"A stalled SSE connection exceeded the deadline.",
			);
		}
		await waitForCaptionTranslation(stalled.page, caption);
		assert.ok(mockApiServer.getMaxActiveResponseCount() <= 5);
		assert.match(
			await stalled.page
				.locator('[data-ot-role="youtube-diagnostics"]')
				.textContent(),
			/request-timeout/,
		);
		await captureEvidence(
			stalled.page,
			"youtube-recovery-after-sse-timeout.png",
		);
	} finally {
		await stalled.close();
	}

	// Healthy same-document navigation must cancel the real provider connection,
	// not merely discard its eventual result or wait for the 30-second deadline.
	const navigation = await openCase();
	try {
		await waitFor(() => mockApiServer.getActiveResponseCount() === 0);
		const abortsBefore = mockApiServer.getAbortedResponseCount();
		const requestsBefore = mockApiServer.getResponseRequestCount();
		mockApiServer.delayNextResponses(10000);
		await installCaptionFixture(
			navigation.page,
			unique("Pending request before healthy navigation"),
		);
		await waitFor(
			() => mockApiServer.getResponseRequestCount() > requestsBefore,
		);
		assert.equal(mockApiServer.getActiveResponseCount(), 1);
		const navigatedAt = Date.now();
		await navigation.page.evaluate(() => {
			history.pushState({}, "", "/watch?v=healthy-navigation");
			window.dispatchEvent(new Event("yt-navigate-finish"));
		});
		await waitFor(
			() => mockApiServer.getAbortedResponseCount() > abortsBefore,
			{
				timeoutMs: 5000,
				timeoutMessage:
					"Healthy SPA navigation did not abort the old API connection before its deadline.",
			},
		);
		assert.ok(Date.now() - navigatedAt < 5000);
		await waitFor(
			async () =>
				(await navigation.control.getAttribute("data-state")) === "idle",
		);
		const current = unique("Native caption on the newly navigated video");
		await installCaptionFixture(navigation.page, current);
		await nativeReadable(navigation.page, current);
		assert.equal(
			await navigation.control.getAttribute("aria-pressed"),
			"false",
		);
	} finally {
		await navigation.close();
	}

	// Worker termination cancels the delayed old provider connection. Also send
	// explicit late old-session messages through Chrome to test delivery guards.
	// Delay the startup acknowledgement at the content boundary to allow a seek
	// and then a same-document video navigation while recovery is outstanding.
	for (const navigate of [false, true]) {
		const delayed = await openCase({ timedTrack: !navigate });
		try {
			mockApiServer.delayNextResponses(3000);
			const old = unique("Old session late provider result");
			const requested = mockApiServer.getResponseRequestCount();
			await installCaptionFixture(delayed.page, old);
			await waitFor(() => mockApiServer.getResponseRequestCount() > requested);
			await delayed.observer.evaluate(() => {
				globalThis.__e2eRecoveryDelay = 2500;
			});
			const checkRestart = await delayed.stopper.stop();
			await delayed.page.evaluate(() =>
				document.querySelector("video").advanceTime(11),
			);
			await waitFor(async () => (await delayed.starts()).length === 2);
			await delayed.page.evaluate((changeVideo) => {
				document.querySelector("video").currentTime = 600;
				document.querySelector("video").playbackRate = 2;
				if (changeVideo) {
					history.pushState({}, "", "/watch?v=navigated-recovery");
					window.dispatchEvent(new Event("yt-navigate-finish"));
				}
			}, navigate);
			const current = unique("Current caption during delayed recovery");
			await installCaptionFixture(delayed.page, current);
			await nativeReadable(delayed.page, current);
			await checkRestart();
			await waitFor(async () =>
				Boolean((await delayed.starts()).at(-1)?.response),
			);
			const sourceId = await delayed.page
				.locator(".ytp-caption-segment")
				.getAttribute("data-ot-source-id");
			const replies = await getExtensionWorker(context, extensionId).evaluate(
				async ({ pageUrl, sessionId, id, sourceText }) => {
					const tab = (await chrome.tabs.query({})).find(
						(candidate) => candidate.url === pageUrl,
					);
					const messages = [
						{
							type: "render-page-translation-updates",
							payload: {
								sessionId,
								translations: [
									{
										id,
										kind: "subtitle",
										sourceText,
										translatedText: "INJECTED OLD SESSION TRANSLATION",
									},
								],
							},
						},
						{
							type: "clear-page-placeholders",
							payload: {
								sessionId,
								ids: [id],
								reason: "api-error",
								retryable: false,
							},
						},
						{
							type: "render-youtube-diagnostic-event",
							payload: {
								sessionId,
								stage: "api-error",
								detail: "INJECTED OLD SESSION DIAGNOSTIC",
							},
						},
					];
					return Promise.all(
						messages.map((message) =>
							chrome.tabs.sendMessage(tab.id, message, { frameId: 0 }),
						),
					);
				},
				{
					pageUrl: delayed.page.url(),
					sessionId: delayed.initial.sessionId,
					id: sourceId || "late-source",
					sourceText: current,
				},
			);
			assert.ok(
				replies.every((reply) => reply.stale === true),
				"Late old-session render, failure, and diagnostics must be rejected.",
			);
			await delayed.page.waitForTimeout(3500);
			assert.doesNotMatch(
				await delayed.page.locator("#movie_player").textContent(),
				/INJECTED OLD SESSION/,
			);
			assert.equal(
				(
					await delayed.page
						.locator('#ytp-caption-window-container [data-ot-role="note"]')
						.allTextContents()
				).some((text) => text.includes(old.slice(0, 30))),
				false,
			);
			if (navigate) {
				assert.equal(
					await delayed.control.getAttribute("data-state"),
					"idle",
					"Navigation must cancel a pending recovery result.",
				);
				assert.equal(
					await delayed.control.getAttribute("aria-pressed"),
					"false",
				);
				await nativeReadable(delayed.page, current);
			} else {
				await waitForCaptionTranslation(delayed.page, current);
				const sessionId = (await delayed.starts()).at(-1).response.sessionId;
				assert.ok(
					(await delayed.observer.messages()).some(
						(entry) =>
							entry.message.type === PROGRESS &&
							entry.message.payload.sessionId === sessionId &&
							entry.message.payload.currentTimeMs === 600000 &&
							entry.message.payload.playbackRate === 2 &&
							entry.response?.sessionStatus === "active",
					),
					"Recovery must refill at the current seek position and playback rate.",
				);
				assert.equal(
					await delayed.control.getAttribute("data-state"),
					"active",
				);
			}
		} finally {
			await delayed.close();
		}
	}

	const exhausted = await openCase();
	try {
		await exhausted.observer.evaluate(() => {
			globalThis.__e2eRejectRecovery = true;
		});
		await exhausted.stopper.stop();
		await exhausted.page.evaluate(() =>
			document.querySelector("video").advanceTime(11),
		);
		await waitFor(async () => (await exhausted.starts()).length === 4, {
			timeoutMs: 25000,
		});
		await waitFor(
			async () =>
				(await exhausted.control.getAttribute("data-state")) === "error",
		);
		const attempts = (await exhausted.starts()).slice(1);
		assert.equal(attempts.length, 3);
		for (let index = 1; index < attempts.length; index += 1) {
			const intervalMs = attempts[index].at - attempts[index - 1].at;
			assert.ok(
				intervalMs >= 10000,
				`Actual recovery requests were only ${intervalMs}ms apart.`,
			);
		}
		await exhausted.page.waitForTimeout(11000);
		assert.equal(
			(await exhausted.starts()).length,
			4,
			"Automatic recovery must stop after three attempts.",
		);
		assert.equal(await exhausted.control.getAttribute("aria-pressed"), "false");
		assert.match(
			await exhausted.control.getAttribute("aria-label"),
			/click|try again|restart/i,
		);
		const caption = unique("Native captions after recovery exhaustion");
		await installCaptionFixture(exhausted.page, caption);
		await nativeReadable(exhausted.page, caption);
		await captureEvidence(exhausted.page, "youtube-recovery-exhausted.png");
	} finally {
		await exhausted.close();
	}
	console.log(
		"Packaged YouTube recovery, deadlines, rebinding, and deterministic long-timeline cases passed.",
	);
}

module.exports = { runYoutubeRecoveryCases };
