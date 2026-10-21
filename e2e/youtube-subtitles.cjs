#!/usr/bin/env node

const assert = require("node:assert/strict");

const {
	REQUEST_TIMEOUT_MS,
	closeExtensionContext,
	createMockApiServer,
	getConfig,
	launchExtensionContext,
	saveOptions,
	takeScreenshot,
	waitFor,
} = require("./lib/extension-test-helpers.cjs");

const {
	getExtensionWorker,
	routeYoutubeFixture,
} = require("./lib/youtube-fixture.cjs");
const { runYoutubeRecoveryCases } = require("./lib/youtube-recovery.cjs");
const { runLiveYoutubePlayerSmoke } = require("./lib/youtube-live-player.cjs");

const YOUTUBE_VIDEO_URL = "https://www.youtube.com/watch?v=subtitle-regression";
const INITIAL_CAPTION = `This result must not survive ${Date.now()}.`;
const CURRENT_CAPTION = `Pi gives you one small tool ${Date.now() + 1}.`;
const CURRENT_CAPTION_PREFIX = "Pi gives you one";
const NEXT_CAPTION = `The next cue stays synchronized ${Date.now() + 2}.`;
const FINAL_CAPTION = `The final cue replaces it cleanly ${Date.now() + 3}.`;
const LONG_CAPTIONS = [
	`Ten minute cue remains available ${Date.now() + 20}.`,
	`Twenty minute cue remains available ${Date.now() + 21}.`,
];
const SEEK_CAPTION = `A seek starts a new urgent window ${Date.now() + 4}.`;
const BILINGUAL_CAPTIONS = [
	`Keep this original caption visible ${Date.now() + 5}.`,
	`Keep this sibling caption visible ${Date.now() + 6}.`,
];
const FALLBACK_CAPTION_SUFFIX = Date.now() + 7;
const FALLBACK_CAPTIONS = [
	"Fallback",
	"Fallback keeps growing",
	`Fallback keeps growing into the latest caption ${FALLBACK_CAPTION_SUFFIX}.`,
];

function buildTimedCaptionFixture() {
	return {
		events: [
			{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: INITIAL_CAPTION }] },
			{ tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: CURRENT_CAPTION }] },
			{ tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: NEXT_CAPTION }] },
			{ tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: FINAL_CAPTION }] },
			{
				tStartMs: 5000,
				dDurationMs: 2000,
				segs: [{ utf8: BILINGUAL_CAPTIONS[0] }],
			},
			{
				tStartMs: 5500,
				dDurationMs: 2000,
				segs: [{ utf8: BILINGUAL_CAPTIONS[1] }],
			},
			...LONG_CAPTIONS.map((text, index) => ({
				tStartMs: (index + 1) * 600000,
				dDurationMs: 2000,
				segs: [{ utf8: text }],
			})),
			{
				tStartMs: 120000,
				dDurationMs: 2000,
				segs: [{ utf8: SEEK_CAPTION }],
			},
		],
	};
}

async function installCaptionFixture(page, captionTexts) {
	const texts = Array.isArray(captionTexts) ? captionTexts : [captionTexts];

	await page.evaluate((fixtureTexts) => {
		document.querySelector("video")?.pause();
		let container = document.querySelector("#ytp-caption-window-container");

		if (!container) {
			container = document.createElement("div");
			container.id = "ytp-caption-window-container";
			(document.querySelector("#movie_player") || document.body).appendChild(
				container,
			);
		}

		container.style.cssText = [
			"position:absolute",
			"z-index:30",
			"left:50%",
			"bottom:12%",
			"transform:translateX(-50%)",
			"width:80%",
			"text-align:center",
			"pointer-events:none",
		].join(";");
		container.replaceChildren();

		const captionWindow = document.createElement("div");
		const captionsText = document.createElement("span");
		const visualLine = document.createElement("span");

		captionWindow.className = "caption-window ytp-caption-window-bottom";
		captionWindow.style.transform = "translateY(0px)";
		captionsText.className = "captions-text";
		captionsText.style.cssText =
			"display:block;color:white;font:500 24px/1.25 Arial,sans-serif;background:rgba(8,8,8,.78);width:max-content;max-width:100%;margin:0 auto;padding:.08em .34em";
		visualLine.className = "caption-visual-line";
		for (const text of fixtureTexts) {
			const segment = document.createElement("span");

			segment.className = "ytp-caption-segment";
			segment.textContent = text;
			visualLine.appendChild(segment);
		}
		captionsText.appendChild(visualLine);
		captionWindow.appendChild(captionsText);
		container.appendChild(captionWindow);
	}, texts);
}

async function installSubtitleTimeline(page) {
	await page.evaluate(() => {
		window.__otSubtitleTimelineObserver?.disconnect();
		window.__otSubtitleTimeline = [];
		const root = document.querySelector("#ytp-caption-window-container");

		window.__otSubtitleTimelineObserver = new MutationObserver((mutations) => {
			const nodeMatches = (node, selector) =>
				Boolean(
					node?.nodeType === Node.ELEMENT_NODE &&
						(node.matches?.(selector) || node.querySelector?.(selector)),
				);
			const mutationTouches = (mutation, selector) =>
				Boolean(
					mutation.target?.parentElement?.closest?.(selector) ||
						mutation.target?.closest?.(selector) ||
						[
							...(mutation.addedNodes || []),
							...(mutation.removedNodes || []),
						].some((node) => nodeMatches(node, selector)),
				);
			const nativeMutation = mutations.some((mutation) =>
				mutationTouches(mutation, ".ytp-caption-segment"),
			);
			const noteMutation = mutations.some((mutation) =>
				mutationTouches(mutation, '[data-ot-role="note"]'),
			);

			if (!nativeMutation && !noteMutation) {
				return;
			}

			window.__otSubtitleTimeline.push({
				nativeMutation,
				nativeTexts: Array.from(
					root.querySelectorAll(".ytp-caption-segment"),
				).map((element) => (element.textContent || "").trim()),
				noteMutation,
				notes: Array.from(root.querySelectorAll('[data-ot-role="note"]')).map(
					(note) => ({
						sourceText: note.getAttribute("data-ot-subtitle-source-text") || "",
						translation:
							note.querySelector('[data-ot-role="note-body"]')?.textContent ||
							"",
					}),
				),
				timestamp: Date.now(),
			});
		});
		window.__otSubtitleTimelineObserver.observe(root, {
			childList: true,
			characterData: true,
			subtree: true,
		});
	});
}

async function setFirstCaptionText(page, text) {
	await page.evaluate((nextText) => {
		const source = document.querySelector(
			"#ytp-caption-window-container .ytp-caption-segment",
		);

		if (source) {
			source.textContent = nextText;
		}
	}, text);
}

async function replaceRenderedCaptionSources(page) {
	await page.evaluate(() => {
		window.__otNotesBeforeSourceReplacement = Array.from(
			document.querySelectorAll(
				'#ytp-caption-window-container [data-ot-role="note"][data-phase="ready"]',
			),
		);
		for (const source of document.querySelectorAll(
			"#ytp-caption-window-container .ytp-caption-segment",
		)) {
			const replacement = source.cloneNode(true);

			for (const attribute of [
				"data-ot-source-id",
				"data-ot-queued",
				"data-translated",
				"data-ot-translated",
				"data-ot-subtitle-replaced",
			]) {
				replacement.removeAttribute(attribute);
			}
			source.replaceWith(replacement);
		}
	});
	await page.waitForTimeout(25);

	return page.evaluate(() => ({
		connectedNoteCount: (window.__otNotesBeforeSourceReplacement || []).filter(
			(note) => note.isConnected,
		).length,
		noteCount: (window.__otNotesBeforeSourceReplacement || []).length,
	}));
}

async function waitForCaptionTranslation(page, sourceText) {
	const note = page
		.locator(
			'#ytp-caption-window-container [data-ot-role="note"][data-phase="ready"]',
		)
		.filter({ hasText: sourceText.slice(0, 30) })
		.first();

	await waitFor(
		async () =>
			((await note.textContent()) || "").includes(sourceText.slice(0, 30)),
		{
			timeoutMs: REQUEST_TIMEOUT_MS,
			timeoutMessage: `The YouTube caption was not translated: ${sourceText}`,
		},
	);

	return note;
}

async function suppressVisibleCaptions(page) {
	await page.evaluate(() => {
		document.querySelector("video")?.pause();
		window.__otSuppressCaptionsTimer = window.setInterval(() => {
			document
				.querySelector("#ytp-caption-window-container")
				?.replaceChildren();
		}, 25);
	});
}

async function stopSuppressingVisibleCaptions(page) {
	await page.evaluate(() => {
		window.clearInterval(window.__otSuppressCaptionsTimer);
		window.__otSuppressCaptionsTimer = null;
	});
}

async function installCaptionTrackMetadata(page, options = {}) {
	await page.evaluate(
		async ({ timedTrack }) => {
			const player = document.querySelector("#movie_player");
			const currentVideoId =
				player?.getVideoData?.()?.video_id ||
				new URLSearchParams(location.search).get("v") ||
				"";
			const track = {
				...(timedTrack
					? {
							baseUrl:
								"https://www.youtube.com/api/timedtext?v=vibe-translator-e2e&lang=en&kind=asr",
						}
					: {}),
				kind: "asr",
				languageCode: "en",
				name: { simpleText: "English (auto-generated)" },
			};
			const response = {
				captions: {
					playerCaptionsTracklistRenderer: { captionTracks: [track] },
				},
				videoDetails: { videoId: currentVideoId },
			};

			window.ytInitialPlayerResponse = {
				...(window.ytInitialPlayerResponse || {}),
				...response,
			};
			if (timedTrack) {
				let requestCount = 0;
				const requestTimer = setInterval(() => {
					fetch(`${track.baseUrl}&fmt=json3&pot=fixture-proof`).catch(() => {});
					requestCount += 1;
					if (requestCount >= 10) {
						clearInterval(requestTimer);
					}
				}, 150);
			}
			if (!timedTrack && player) {
				Object.defineProperty(player, "getPlayerResponse", {
					configurable: true,
					value: () => response,
				});
				const originalGetOption = player.getOption?.bind(player);

				Object.defineProperty(player, "getOption", {
					configurable: true,
					value(group, key) {
						if (group === "captions" && key === "tracklist") {
							return [track];
						}
						if (group === "captions" && key === "track") {
							return track;
						}
						return originalGetOption?.(group, key);
					},
				});
			}
		},
		{ timedTrack: options.timedTrack !== false },
	);
}

async function clearStoredSettings(context, extensionId) {
	const worker = getExtensionWorker(context, extensionId);

	await worker.evaluate(() =>
		Promise.all([
			new Promise((resolve) => chrome.storage.local.clear(resolve)),
			new Promise((resolve) => chrome.storage.sync.clear(resolve)),
		]),
	);
}

async function main() {
	const config = getConfig();
	const mockApiServer = await createMockApiServer({ responseDelayMs: 500 });
	let runState;

	config.baseUrl = mockApiServer.baseUrl;
	config.useMockApi = true;
	config.headless = true;

	try {
		runState = await launchExtensionContext(config);
		await routeYoutubeFixture(runState.context);
		await runState.context.route(
			"https://www.youtube.com/api/timedtext?v=vibe-translator-e2e**",
			(route) =>
				route.fulfill({
					body: JSON.stringify(buildTimedCaptionFixture()),
					contentType: "application/json",
					status: 200,
				}),
		);
		await saveOptions(runState.context, runState.extensionId, config, {
			runConnectionTest: false,
		});

		if (process.argv.includes("--fixture-only")) {
			console.log(
				"Live YouTube smoke not run: --fixture-only uses the packaged synthetic player.",
			);
		} else {
			await runLiveYoutubePlayerSmoke({ ...runState, config });
		}

		const page = await runState.context.newPage();
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto(YOUTUBE_VIDEO_URL, {
			timeout: REQUEST_TIMEOUT_MS,
			waitUntil: "domcontentloaded",
		});
		await page.bringToFront();
		await installCaptionTrackMetadata(page);

		const player = page.locator("#movie_player");
		const control = player.locator("[data-ot-youtube-control]");
		await waitFor(async () => (await control.count()) === 1, {
			timeoutMessage: "The Vibe Translator player control did not appear.",
		});
		const controlBounds = await control.boundingBox();
		const playerBounds = await player.boundingBox();
		assert.ok(
			controlBounds && playerBounds,
			"Expected visible control bounds.",
		);
		assert.ok(controlBounds.x >= playerBounds.x);
		assert.ok(
			controlBounds.x + controlBounds.width <=
				playerBounds.x + playerBounds.width,
		);
		assert.ok(controlBounds.y >= playerBounds.y);
		assert.ok(
			controlBounds.y + controlBounds.height <=
				playerBounds.y + playerBounds.height,
		);
		assert.equal(await control.getAttribute("aria-pressed"), "false");
		assert.match(
			(await control.getAttribute("aria-label")) || "",
			/Translate subtitles with Vibe Translator/,
		);
		assert.equal(
			await control.evaluate((element) => getComputedStyle(element).color),
			"rgb(255, 255, 255)",
			"The player-control state styles must exist before translation starts.",
		);
		await control.click();
		const diagnosticsPanel = player.locator(
			'[data-ot-role="youtube-diagnostics"]',
		);
		await waitFor(async () => (await diagnosticsPanel.count()) === 1, {
			timeoutMessage:
				"The player diagnostic panel did not appear after a real click.",
		});
		assert.match(
			(await diagnosticsPanel.textContent()) || "",
			/Player button click received/,
		);
		assert.doesNotMatch(
			(await diagnosticsPanel.textContent()) || "",
			new RegExp(config.apiKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
		const diagnosticOutput = diagnosticsPanel.locator("pre");
		const pauseDiagnostics = diagnosticsPanel.getByRole("button", {
			name: "Pause diagnostics",
		});

		await pauseDiagnostics.click();
		const frozenDiagnostics = await diagnosticOutput.textContent();
		await page.waitForTimeout(300);
		assert.equal(await diagnosticOutput.textContent(), frozenDiagnostics);
		await diagnosticsPanel
			.getByRole("button", { name: "Resume diagnostics" })
			.click();
		await waitFor(
			async () => (await control.getAttribute("data-state")) !== "idle",
			{
				timeoutMessage:
					"A YouTube-replaced player control did not accept a real click.",
			},
		);
		await installCaptionFixture(page, INITIAL_CAPTION);

		const source = page.locator(
			"#ytp-caption-window-container .ytp-caption-segment",
		);
		await waitFor(
			async () => Boolean(await source.getAttribute("data-ot-source-id")),
			{
				timeoutMessage: "The initial YouTube caption was not queued.",
			},
		);
		const initialSourceId = await source.getAttribute("data-ot-source-id");
		await page.evaluate((text) => {
			const source = document.querySelector(
				"#ytp-caption-window-container .ytp-caption-segment",
			);
			const replacement = source?.cloneNode(true);

			if (source && replacement) {
				source.remove();
				replacement.removeAttribute("data-ot-source-id");
				replacement.removeAttribute("data-ot-queued");
				replacement.removeAttribute("data-translated");
				replacement.removeAttribute("data-ot-translated");
				replacement.removeAttribute("data-ot-subtitle-replaced");
				replacement.textContent = text;
				document
					.querySelector("#ytp-caption-window-container .caption-visual-line")
					?.appendChild(replacement);
			}
		}, CURRENT_CAPTION_PREFIX);
		await waitFor(
			async () => {
				const currentSourceId = await source.getAttribute("data-ot-source-id");

				return Boolean(currentSourceId && currentSourceId !== initialSourceId);
			},
			{
				timeoutMessage:
					"The changed cue did not receive a new source identity.",
			},
		);
		await page.evaluate(() => {
			window.__otObservedSubtitleTranslations = [];
			new MutationObserver(() => {
				const text = Array.from(
					document.querySelectorAll(
						'#ytp-caption-window-container [data-ot-role="note-body"]',
					),
				)
					.map((element) => element.textContent || "")
					.join("\n");

				if (text) {
					window.__otObservedSubtitleTranslations.push(text);
				}
			}).observe(document.querySelector("#ytp-caption-window-container"), {
				childList: true,
				characterData: true,
				subtree: true,
			});
		});
		await waitFor(
			async () => Boolean(await source.getAttribute("data-ot-source-id")),
			{
				timeoutMessage: "The changed cue was not queued before replacement.",
			},
		);
		await page.evaluate(() => {
			const source = document.querySelector(
				"#ytp-caption-window-container .ytp-caption-segment",
			);
			const replacement = source?.cloneNode(true);

			if (source && replacement) {
				for (const attribute of [
					"data-ot-source-id",
					"data-ot-queued",
					"data-translated",
					"data-ot-translated",
					"data-ot-subtitle-replaced",
				]) {
					replacement.removeAttribute(attribute);
				}
				source.replaceWith(replacement);
			}
		});
		await waitFor(
			async () => (await control.getAttribute("data-state")) === "active",
			{
				timeoutMs: REQUEST_TIMEOUT_MS,
				timeoutMessage: "The in-player control did not become active.",
			},
		);

		await waitFor(
			async () =>
				/timed-prefix=1/.test((await diagnosticsPanel.textContent()) || ""),
			{
				timeoutMs: 10000,
				timeoutMessage:
					"The progressive native caption did not use the active timed cue.",
			},
		).catch(async (error) => {
			error.message += `\nDiagnostics:\n${await diagnosticsPanel.textContent()}`;
			throw error;
		});
		const progressiveDiagnostics = (await diagnosticsPanel.textContent()) || "";
		const trackedCaptionRequests = await page.evaluate(() =>
			(globalThis.__otCaptionRequestTracker?.urls || []).map((value) => {
				const url = new URL(value);

				return {
					hasPot: url.searchParams.has("pot"),
					kind: url.searchParams.get("kind"),
					lang: url.searchParams.get("lang"),
					v: url.searchParams.get("v"),
				};
			}),
		);
		assert.match(progressiveDiagnostics, /"prefetchAvailable": true/);
		assert.match(
			progressiveDiagnostics,
			/"trackSource": "native-request"/,
			`Tracked caption requests: ${JSON.stringify(trackedCaptionRequests)}`,
		);
		assert.doesNotMatch(
			progressiveDiagnostics,
			/api\/timedtext|fixture-proof/u,
		);

		const readyNotes = page.locator(
			'#ytp-caption-window-container [data-ot-role="note"][data-phase="ready"]',
		);
		const readyNote = readyNotes
			.filter({ hasText: CURRENT_CAPTION.slice(0, 30) })
			.first();
		await waitFor(
			async () =>
				((await readyNote.textContent()) || "").includes(
					CURRENT_CAPTION.slice(0, 30),
				),
			{
				timeoutMs: REQUEST_TIMEOUT_MS,
				timeoutMessage: "The changed YouTube caption was not translated.",
			},
		);
		try {
			await waitFor(
				async () => {
					const text = (await diagnosticsPanel.textContent()) || "";
					return (
						/api-start|Requesting 1 caption translation/.test(text) &&
						/api-success|API returned/.test(text) &&
						/render|rendered 1/.test(text)
					);
				},
				{
					timeoutMs: REQUEST_TIMEOUT_MS,
					timeoutMessage:
						"The diagnostic panel did not report the complete caption pipeline.",
				},
			);
		} catch (error) {
			error.message += `\nDiagnostics:\n${(await diagnosticsPanel.textContent()) || "unavailable"}`;
			throw error;
		}

		const playerText =
			(await page.locator("#ytp-caption-window-container").textContent()) || "";
		assert.match(
			playerText,
			new RegExp(CURRENT_CAPTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
		const staleTranslationPrefix = `[mock:${INITIAL_CAPTION.slice(0, 48)}`;
		const observedTranslations = (
			await page.evaluate(() => window.__otObservedSubtitleTranslations || [])
		).join("\n");
		assert.equal(
			playerText.includes(staleTranslationPrefix),
			false,
			`Stale player text: ${playerText}`,
		);
		assert.equal(
			observedTranslations.includes(staleTranslationPrefix),
			false,
			`A late result rendered briefly: ${observedTranslations}`,
		);
		assert.equal(
			await readyNote.getAttribute("data-ot-presentation"),
			"subtitle",
		);
		assert.equal(
			await source.evaluate((element) => getComputedStyle(element).display),
			"none",
			"The translated subtitle should replace the visible native caption.",
		);
		assert.notEqual(
			await readyNote.evaluate((element) => getComputedStyle(element).display),
			"none",
		);
		assert.equal(
			await readyNote
				.locator('[data-ot-role="note-label"]')
				.evaluate((element) => getComputedStyle(element).display),
			"none",
		);
		assert.equal(
			await readyNote.evaluate((element) => getComputedStyle(element).fontSize),
			"24px",
		);
		assert.equal(await control.getAttribute("aria-pressed"), "true");

		await waitFor(
			async () => {
				const ids = mockApiServer.getResponseItemIds();
				return (
					ids.some((id) => /^youtube-cue-2000-/u.test(id)) &&
					ids.some((id) => /^youtube-cue-3000-/u.test(id))
				);
			},
			{ timeoutMessage: "The rate timeline was not prefetched." },
		);
		await page.waitForTimeout(600);
		const visibleFallbacksBeforeTimeline = mockApiServer
			.getResponseItemIds()
			.filter((id) => id.startsWith("ot-")).length;
		await installSubtitleTimeline(page);
		await page.evaluate(() => {
			const video = document.querySelector("#movie_player video");

			if (video) {
				video.playbackRate = 1;
			}
		});
		await setFirstCaptionText(page, NEXT_CAPTION);
		await waitForCaptionTranslation(page, NEXT_CAPTION);
		await page.evaluate(() => {
			const video = document.querySelector("#movie_player video");

			if (video) {
				video.playbackRate = 2;
			}
		});
		await waitFor(
			async () =>
				/rate=2; window=120000ms/.test(
					(await diagnosticsPanel.textContent()) || "",
				),
			{
				timeoutMessage:
					"The 2x playback rate did not request a 120-second window.",
			},
		);
		await setFirstCaptionText(page, FINAL_CAPTION);
		await waitForCaptionTranslation(page, FINAL_CAPTION);
		assert.equal(
			mockApiServer.getResponseItemIds().filter((id) => id.startsWith("ot-"))
				.length,
			visibleFallbacksBeforeTimeline,
			"Prefetched 1x and 2x cues should not use visible-caption API fallback.",
		);

		await page.evaluate(() => {
			const video = document.querySelector("#movie_player video");

			if (video) {
				video.currentTime = 120;
			}
		});
		await waitFor(
			async () =>
				mockApiServer
					.getResponseItemIds()
					.some((id) => /^youtube-cue-120000-/u.test(id)),
			{ timeoutMessage: "The seek window was not prefetched." },
		);
		await page.waitForTimeout(600);
		const visibleFallbacksBeforeSeekCue = mockApiServer
			.getResponseItemIds()
			.filter((id) => id.startsWith("ot-")).length;
		await setFirstCaptionText(page, SEEK_CAPTION);
		await waitForCaptionTranslation(page, SEEK_CAPTION);
		assert.equal(
			mockApiServer.getResponseItemIds().filter((id) => id.startsWith("ot-"))
				.length,
			visibleFallbacksBeforeSeekCue,
			"A prefetched seek cue should not use visible-caption API fallback.",
		);
		const subtitleTimeline = await page.evaluate(
			() => window.__otSubtitleTimeline || [],
		);
		assert.ok(
			subtitleTimeline.some((entry) => entry.nativeMutation),
			"Expected timestamped native caption mutations.",
		);
		assert.ok(
			subtitleTimeline.some((entry) => entry.noteMutation),
			"Expected timestamped translated-note mutations.",
		);
		assert.ok(
			subtitleTimeline.every(
				(entry, index, entries) =>
					Number.isFinite(entry.timestamp) &&
					(index === 0 || entry.timestamp >= entries[index - 1].timestamp),
			),
			"Subtitle mutation timestamps should be ordered.",
		);
		const staleTimelineEntries = subtitleTimeline.filter((entry) =>
			entry.notes.some(
				(note) =>
					note.sourceText && !entry.nativeTexts.includes(note.sourceText),
			),
		);
		assert.deepEqual(
			staleTimelineEntries,
			[],
			`A translated note outlived its exact native cue: ${JSON.stringify(staleTimelineEntries)}`,
		);
		for (const caption of [NEXT_CAPTION, FINAL_CAPTION, SEEK_CAPTION]) {
			assert.ok(
				subtitleTimeline.some((entry) =>
					entry.notes.some((note) => note.sourceText === caption),
				),
				`The timeline did not record the translated cue: ${caption}`,
			);
		}

		await saveOptions(runState.context, runState.extensionId, config, {
			runConnectionTest: false,
			youtubeSubtitleDisplayMode: "bilingual",
		});
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.bringToFront();
		await installCaptionTrackMetadata(page);
		const bilingualControl = page.locator(
			"#movie_player [data-ot-youtube-control]",
		);
		await waitFor(async () => (await bilingualControl.count()) === 1, {
			timeoutMessage: "The bilingual player control did not appear.",
		});
		await bilingualControl.click();
		await installCaptionFixture(page, BILINGUAL_CAPTIONS);
		await waitFor(
			async () =>
				(await bilingualControl.getAttribute("data-state")) === "active",
			{
				timeoutMs: REQUEST_TIMEOUT_MS,
				timeoutMessage: "The bilingual subtitle session did not become active.",
			},
		);
		for (const caption of BILINGUAL_CAPTIONS) {
			const bilingualNote = await waitForCaptionTranslation(page, caption);
			const bilingualSource = page
				.locator("#ytp-caption-window-container .ytp-caption-segment")
				.filter({ hasText: caption })
				.first();

			assert.notEqual(
				await bilingualSource.evaluate(
					(element) => getComputedStyle(element).display,
				),
				"none",
				"Bilingual mode should preserve the exact native caption segment.",
			);
			assert.equal(
				await bilingualSource.getAttribute("data-ot-subtitle-replaced"),
				null,
			);
			assert.equal(
				await bilingualNote.getAttribute("data-ot-subtitle-display-mode"),
				"bilingual",
			);
		}
		for (
			let replacementIndex = 0;
			replacementIndex < 3;
			replacementIndex += 1
		) {
			assert.deepEqual(await replaceRenderedCaptionSources(page), {
				connectedNoteCount: BILINGUAL_CAPTIONS.length,
				noteCount: BILINGUAL_CAPTIONS.length,
			});
		}

		await page.reload({ waitUntil: "domcontentloaded" });
		await page.bringToFront();
		await installCaptionTrackMetadata(page, { timedTrack: false });
		const fallbackControl = page.locator(
			"#movie_player [data-ot-youtube-control]",
		);
		await waitFor(async () => (await fallbackControl.count()) === 1, {
			timeoutMessage: "The fallback player control did not appear.",
		});
		await fallbackControl.click();
		await waitFor(
			async () =>
				(await fallbackControl.getAttribute("data-state")) === "error",
			{
				timeoutMs: 15000,
				timeoutMessage:
					"The caption visibility timeout did not enter its recoverable error state.",
			},
		);
		const fallbackIdsBefore = mockApiServer
			.getResponseItemIds()
			.filter((id) => id.startsWith("ot-")).length;

		await installCaptionFixture(page, FALLBACK_CAPTIONS[0]);
		await waitFor(
			async () =>
				mockApiServer.getResponseItemIds().filter((id) => id.startsWith("ot-"))
					.length > fallbackIdsBefore,
			{
				timeoutMessage: "The first visible-caption fallback was not requested.",
			},
		);
		await setFirstCaptionText(page, FALLBACK_CAPTIONS[1]);
		await page.waitForTimeout(250);
		await setFirstCaptionText(page, FALLBACK_CAPTIONS[2]);
		await waitForCaptionTranslation(page, FALLBACK_CAPTIONS[2]);
		await waitFor(
			async () =>
				(await fallbackControl.getAttribute("data-state")) === "active",
			{
				timeoutMessage:
					"Visible captions did not recover the player control from timeout.",
			},
		);
		const fallbackRequestCount =
			mockApiServer.getResponseItemIds().filter((id) => id.startsWith("ot-"))
				.length - fallbackIdsBefore;
		assert.ok(
			fallbackRequestCount <= 2,
			`Progressive fallback used ${fallbackRequestCount} requests instead of coalescing to the latest snapshot.`,
		);
		const fallbackDiagnostics =
			(await page
				.locator('[data-ot-role="youtube-diagnostics"]')
				.textContent()) || "";
		assert.match(fallbackDiagnostics, /fallback-coalesced|coalesced=1/);
		assert.match(fallbackDiagnostics, /"provisionalResults": [1-9]/);
		assert.match(fallbackDiagnostics, /"prefetchAvailable": false/);
		assert.match(fallbackDiagnostics, /"timedTrackAvailable": false/);
		assert.doesNotMatch(fallbackDiagnostics, /api\/timedtext/u);
		assert.doesNotMatch(fallbackDiagnostics, /missing target [1-9]/);

		await runYoutubeRecoveryCases({
			...runState,
			config,
			mockApiServer,
			installCaptionFixture,
			installCaptionTrackMetadata,
			waitForCaptionTranslation,
			longCaptions: LONG_CAPTIONS,
		});

		await clearStoredSettings(runState.context, runState.extensionId);
		await page.reload({ waitUntil: "domcontentloaded" });
		const reloadedControl = page.locator(
			"#movie_player [data-ot-youtube-control]",
		);
		await waitFor(async () => (await reloadedControl.count()) === 1, {
			timeoutMessage: "The player control did not return after reload.",
		});
		await reloadedControl.dispatchEvent("click");
		await waitFor(
			async () =>
				(await reloadedControl.getAttribute("data-state")) === "error",
			{
				timeoutMessage:
					"Missing settings did not produce a visible player-control error.",
			},
		);
		assert.match(
			(await reloadedControl.getAttribute("aria-label")) || "",
			/(Configure Vibe Translator|could not start)/,
		);
		assert.match(
			(await page
				.locator('[data-ot-role="youtube-diagnostics"]')
				.textContent()) || "",
			/(Configure Vibe Translator|could not start)/,
		);
		assert.equal(await reloadedControl.getAttribute("aria-pressed"), "false");

		await saveOptions(runState.context, runState.extensionId, config, {
			runConnectionTest: false,
		});
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.waitForTimeout(750);
		await installCaptionTrackMetadata(page, { timedTrack: false });
		const noCaptionControl = page.locator(
			"#movie_player [data-ot-youtube-control]",
		);
		await waitFor(async () => (await noCaptionControl.count()) === 1, {
			timeoutMessage: "The no-caption player control did not appear.",
		});
		await suppressVisibleCaptions(page);
		await noCaptionControl.click();
		try {
			await waitFor(
				async () =>
					/YouTube captions are not visible/.test(
						(await page
							.locator('[data-ot-role="youtube-diagnostics"]')
							.textContent()) || "",
					),
				{
					timeoutMs: 15000,
					timeoutMessage:
						"Missing native captions did not produce actionable feedback.",
				},
			);
		} catch (error) {
			error.message += `\nControl state: ${await noCaptionControl.getAttribute("data-state")}\nDiagnostics:\n${(await page.locator('[data-ot-role="youtube-diagnostics"]').textContent()) || "unavailable"}`;
			throw error;
		}
		await stopSuppressingVisibleCaptions(page);
		assert.ok(
			mockApiServer.getMaxActiveResponseCount() <= 5,
			`Subtitle API concurrency exceeded five: ${mockApiServer.getMaxActiveResponseCount()}`,
		);

		await takeScreenshot(
			page,
			config.artifactsDir,
			"youtube-subtitle-translation.png",
			false,
		);
		await page.close();
		console.log("YouTube subtitle translation smoke passed.");
	} finally {
		await closeExtensionContext(runState);
		await mockApiServer.close();
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
