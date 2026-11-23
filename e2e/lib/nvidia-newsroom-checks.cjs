const assert = require("node:assert/strict");
const path = require("node:path");
const {
	ROOT_DIR,
	callBackground,
	takeScreenshot,
} = require("./extension-test-helpers.cjs");

const NVIDIA_NEWSROOM_ORIGIN = "https://nvidianews.nvidia.com";
const FIXTURE_URL = `${NVIDIA_NEWSROOM_ORIGIN}/news/article-fixture`;
const FIXTURE_PATH = path.join(ROOT_DIR, "test", "nvidia-newsroom-page.html");

async function checkNvidiaNewsroomTranslation(context, artifactsDir) {
	for (const width of [1440, 390]) {
		const page = await context.newPage();
		try {
			await page.setViewportSize({ width, height: 720 });
			await page.route(FIXTURE_URL, (route) =>
				route.fulfill({ path: FIXTURE_PATH }),
			);
			await page.goto(FIXTURE_URL, { waitUntil: "domcontentloaded" });
			const article = page.locator(".main-content > .article");
			const sources = article.locator(
				".article-title, .article-body > p:not([data-ot-role])",
			);
			const originals = await sources.allTextContents();
			assert.equal(originals.length, 6);

			const response = await callBackground(context, "translatePage", {
				pageUrl: FIXTURE_URL,
			});
			assert.equal(response.ok, true, JSON.stringify(response));

			const notes = page.locator('[data-ot-role="note"]');
			const readyNotes = notes.and(page.locator('[data-phase="ready"]'));
			for (const [index, source] of (await sources.all()).entries()) {
				await source.scrollIntoViewIfNeeded();
				await source
					.locator("xpath=following-sibling::*[1]")
					.and(readyNotes)
					.waitFor({ state: "visible", timeout: 10000 });
				const result = await source.evaluate((element) => {
					const note = element.nextElementSibling;
					const noteBox = note.getBoundingClientRect();
					const sourceBox = element.getBoundingClientRect();
					return {
						original: element.textContent,
						text: note.querySelector('[data-ot-role="note-body"]').textContent,
						matchesSource:
							note.getAttribute("data-ot-note-id") ===
							element.getAttribute("data-ot-source-id"),
						belowSource: noteBox.top >= sourceBox.bottom - 1,
						inBounds:
							noteBox.left >= sourceBox.left - 1 &&
							noteBox.right <= sourceBox.right + 1,
					};
				});
				assert.equal(result.original, originals[index]);
				assert.match(result.text, /^\[mock:/);
				assert.equal(result.matchesSource, true);
				assert.equal(result.belowSource, true);
				assert.equal(result.inBounds, true);
			}

			assert.equal(await notes.count(), originals.length);
			assert.equal(await page.locator("aside [data-ot-source-id]").count(), 0);
			assert.equal(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				true,
			);
			await takeScreenshot(page, artifactsDir, `nvidia-newsroom-${width}.png`);
			console.log(`NVIDIA Newsroom translation passed at ${width}px.`);
		} finally {
			await page.close();
		}
	}
}

module.exports = { checkNvidiaNewsroomTranslation, NVIDIA_NEWSROOM_ORIGIN };
