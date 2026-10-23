const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
	saveOptions,
	takeScreenshot,
	waitFor,
} = require("./extension-test-helpers.cjs");

async function runYoutubeRenderingCases(options) {
	const {
		context,
		extensionId,
		config,
		mockApiServer,
		installCaptionFixture,
		installCaptionTrackMetadata,
		waitForCaptionTranslation,
	} = options;
	const trackUrl =
		"https://www.youtube.com/api/timedtext?v=caption-gap&lang=en&kind=asr";
	await context.route(
		"https://www.youtube.com/api/timedtext?v=caption-gap**",
		(route) => route.fulfill({ status: 200, body: "" }),
	);
	for (const mode of ["translation-only", "bilingual"]) {
		await saveOptions(context, extensionId, config, {
			runConnectionTest: false,
			youtubeSubtitleDisplayMode: mode,
		});
		const page = await context.newPage();
		try {
			await page.setViewportSize({ width: 1280, height: 800 });
			await page.goto(
				`https://www.youtube.com/watch?v=recovery-rendering-${mode}`,
				{ waitUntil: "domcontentloaded" },
			);
			await page.bringToFront();
			await installCaptionTrackMetadata(page, { baseUrl: trackUrl });
			const baseline = `Earlier successful caption ${mode} ${Date.now()}`;
			await installCaptionFixture(page, baseline);
			const control = page.locator("[data-ot-youtube-control]");
			await control.waitFor();
			await control.click();
			await waitForCaptionTranslation(page, baseline);
			await waitFor(
				async () => (await control.getAttribute("data-state")) === "active",
			);
			const report = () =>
				page.locator('[data-ot-role="youtube-diagnostics"] pre').textContent();
			const before = await report();
			assert.match(before, /"timedTrackAvailable": true/);
			assert.match(before, /"prefetchAvailable": false/);
			assert.match(before, /reason=empty-body/);
			await fs.writeFile(
				path.join(config.artifactsDir, `youtube-rendering-${mode}-before.txt`),
				before,
			);

			// Unlike the old finite fallback test, captions never become quiet
			// before we require ready notes. Rebuilding nodes also removes the
			// last extracted identity while its response is still in flight.
			mockApiServer.setResponseDelayMs(800);
			await installCaptionFixture(page, `Continuous ${mode} caption`);
			await page.evaluate(() => {
				const state = {
					running: true,
					mutations: 0,
					renderedSnapshots: [],
					duplicateNotes: false,
					segmentCounts: [],
				};
				window.__e2eGrowingCaptions = state;
				const root = document.querySelector("#ytp-caption-window-container");
				const sample = () => {
					const sources = Array.from(
						root.querySelectorAll(".ytp-caption-segment"),
					);
					const notes = Array.from(
						root.querySelectorAll('[data-ot-role="note"][data-phase="ready"]'),
					);
					const ids = notes.map((note) => note.getAttribute("data-ot-note-id"));
					if (new Set(ids).size !== ids.length) state.duplicateNotes = true;
					for (const note of notes) {
						const snapshot = note.getAttribute("data-ot-subtitle-source-text");
						const source = sources.find(
							(candidate) =>
								candidate.getAttribute("data-ot-source-id") ===
								note.getAttribute("data-ot-note-id"),
						);
						if (
							state.running &&
							source === sources[0] &&
							snapshot &&
							source?.textContent.startsWith(snapshot) &&
							!state.renderedSnapshots.includes(snapshot)
						)
							state.renderedSnapshots.push(snapshot);
					}
				};
				state.observer = new MutationObserver(sample);
				state.observer.observe(root, {
					subtree: true,
					childList: true,
					attributes: true,
				});
				state.timer = setInterval(() => {
					let source = root.querySelector(".ytp-caption-segment");
					state.mutations += 1;
					source.textContent += ` word${state.mutations}`;
					if (state.mutations % 2 === 0) {
						const replacement = document.createElement("span");
						replacement.className = "ytp-caption-segment";
						replacement.textContent = source.textContent;
						source.replaceWith(replacement);
						source = replacement;
					}
					if (state.mutations === 10) {
						const sibling = document.createElement("span");
						sibling.className = "ytp-caption-segment";
						sibling.textContent = "A separate simultaneous caption";
						source.parentElement.appendChild(sibling);
					}
					if (state.mutations === 40)
						root.querySelectorAll(".ytp-caption-segment")[1]?.remove();
					const count = root.querySelectorAll(".ytp-caption-segment").length;
					if (state.segmentCounts.at(-1) !== count)
						state.segmentCounts.push(count);
				}, 40);
			});
			await waitFor(
				() =>
					page.evaluate(() => {
						const state = window.__e2eGrowingCaptions;
						return state.mutations > 40 && state.renderedSnapshots.length >= 3;
					}),
				{
					timeoutMs: 12000,
					intervalMs: 50,
					timeoutMessage:
						"Safe fallback results must render while caption mutations continue.",
				},
			);
			const evidence = await page.evaluate(() => {
				const state = window.__e2eGrowingCaptions;
				return {
					running: state.running,
					mutationCount: state.mutations,
					readySnapshots: state.renderedSnapshots.length,
					duplicateNotes: state.duplicateNotes,
					segmentCounts: state.segmentCounts,
				};
			});
			assert.equal(evidence.running, true);
			assert.equal(evidence.duplicateNotes, false);
			assert.deepEqual(evidence.segmentCounts, [1, 2, 1]);
			const after = await report();
			assert.match(after, /"provisionalResults": [1-9]/);
			const snapshot = JSON.parse(after.slice(after.indexOf("{"))).snapshot;
			assert.ok(snapshot.captionFallback.activeSlotCount <= 2);
			assert.ok(snapshot.captionFallback.coalescedFallbackCount > 0);
			assert.doesNotMatch(
				after,
				/api\/timedtext|fixture-proof|word\d|A separate simultaneous caption/,
			);
			await fs.writeFile(
				path.join(config.artifactsDir, `youtube-rendering-${mode}-after.txt`),
				after,
			);
			await takeScreenshot(
				page,
				config.artifactsDir,
				`youtube-rendering-${mode}.png`,
				false,
			);
			await page.evaluate(() => {
				const state = window.__e2eGrowingCaptions;
				state.running = false;
				clearInterval(state.timer);
				state.observer.disconnect();
			});
			mockApiServer.setResponseDelayMs(500);
			const unrelated = `Unrelated next caption ${mode} ${Date.now()}`;
			await installCaptionFixture(page, unrelated);
			// A late prefix result must never hide the new, unrelated native cue.
			await page.waitForTimeout(100);
			assert.notEqual(
				await page
					.locator(".ytp-caption-segment")
					.evaluate((source) => getComputedStyle(source).display),
				"none",
			);
			await waitForCaptionTranslation(page, unrelated);
			await page.waitForTimeout(900);
			assert.equal(
				await page.locator('[data-ot-role="note"][data-phase="ready"]').count(),
				1,
			);
			assert.equal(
				await page
					.locator(".ytp-caption-segment")
					.evaluate((source) => getComputedStyle(source).display === "none"),
				mode === "translation-only",
			);
			console.log(
				`Continuous fallback rendering (${mode}): ${JSON.stringify(evidence)}`,
			);
		} catch (error) {
			const report = await page
				.locator('[data-ot-role="youtube-diagnostics"] pre')
				.textContent()
				.catch(() => "No report");
			await fs.writeFile(
				path.join(config.artifactsDir, `youtube-rendering-${mode}-failure.txt`),
				report,
			);
			console.error(
				"Rendering fixture state",
				await page.evaluate(() => {
					const state = window.__e2eGrowingCaptions;
					return (
						state && {
							mutations: state.mutations,
							renderedSnapshots: state.renderedSnapshots.length,
							duplicateNotes: state.duplicateNotes,
							segmentCounts: state.segmentCounts,
						}
					);
				}),
			);
			throw error;
		} finally {
			mockApiServer.setResponseDelayMs(500);
			await page.close();
		}
	}
	await context.unroute(
		"https://www.youtube.com/api/timedtext?v=caption-gap**",
	);
}

module.exports = { runYoutubeRenderingCases };
