const assert = require("node:assert/strict");
const { takeScreenshot, waitFor } = require("./extension-test-helpers.cjs");

// This checks the current live YouTube DOM, not the synthetic recovery player.
// Translation requests still use the local mock provider configured by the caller.
async function runLiveYoutubePlayerSmoke({ context, config }) {
	const page = await context.newPage();
	try {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto("https://www.youtube.com/watch?v=g7AxxkywiFI", {
			waitUntil: "domcontentloaded",
			timeout: 60000,
		});
		const player = page.locator("#movie_player");
		const control = player.locator("[data-ot-youtube-control]");
		await control.waitFor({ timeout: 30000 });
		assert.equal(await control.count(), 1);
		assert.equal(await player.locator("video").count(), 1);
		assert.ok(await player.locator(".ytp-subtitles-button").count());
		assert.equal(
			await player.evaluate((element) => typeof element.getPlayerResponse),
			"function",
			"The live page must expose the real MAIN-world player, not fixture methods.",
		);
		const bounds = await control.boundingBox();
		const playerBounds = await player.boundingBox();
		assert.ok(bounds && playerBounds);
		assert.ok(bounds.x >= playerBounds.x && bounds.y >= playerBounds.y);
		assert.ok(bounds.x + bounds.width <= playerBounds.x + playerBounds.width);
		assert.ok(bounds.y + bounds.height <= playerBounds.y + playerBounds.height);
		assert.equal(await control.getAttribute("aria-pressed"), "false");
		assert.equal(
			await control.evaluate((element) => getComputedStyle(element).color),
			"rgb(255, 255, 255)",
		);
		await control.click();
		await waitFor(
			async () =>
				/Player button click received/.test(
					await player
						.locator('[data-ot-role="youtube-diagnostics"]')
						.textContent(),
				),
			{
				timeoutMessage:
					"The real YouTube control did not receive a user click.",
			},
		);
		await waitFor(
			async () => (await control.getAttribute("data-state")) === "active",
			{
				timeoutMs: 35000,
				timeoutMessage: "Subtitle startup failed on the live YouTube player.",
			},
		);
		assert.equal(await control.getAttribute("aria-pressed"), "true");
		await takeScreenshot(
			page,
			config.artifactsDir,
			"youtube-live-player.png",
			false,
		);
		console.log(
			"Live YouTube DOM, packaged injection, player bounds, and real-click startup smoke passed (mock provider).",
		);
	} catch (error) {
		error.message += `\nLive YouTube prerequisite: public watch page with a video player and captions control. URL: ${page.url()}`;
		throw error;
	} finally {
		await page.close();
	}
}

module.exports = { runLiveYoutubePlayerSmoke };
