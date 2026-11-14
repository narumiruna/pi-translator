const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

async function checkRootVisibility(page, origin) {
	const artifactsDir = path.resolve(__dirname, "../../e2e-artifacts");
	await fs.mkdir(artifactsDir, { recursive: true });
	for (const width of [1440, 390]) {
		await page.setViewportSize({ width, height: 1000 });
		for (const mode of [
			"hidden-ancestor",
			"display-none",
			"visibility-hidden",
			"content-visibility-hidden",
			"visible-embed",
			"offscreen-embed",
			"contents-embed",
			"offscreen-contents-embed",
			"hidden-contents-ancestor",
			"hidden-contents-text",
			"hidden-contents-content",
			"visibility-override",
			"offscreen-visibility-override",
			"collapse-override",
		]) {
			await page.goto(`${origin}/test/root-visibility-page.html`);
			const result = await page.evaluate(async (mode) => {
				const cache = document.querySelector("#cache");
				const embed = document.querySelector("#embed");
				const gist = document.querySelector("#gist");
				const embedded = mode.endsWith("embed");
				const visible = embedded ? gist : cache;
				const hidden = embedded ? cache : gist;
				const offscreen = mode.startsWith("offscreen");
				if (mode.includes("contents")) gist.style.display = "contents";
				if (mode.endsWith("override")) {
					cache.style.visibility =
						mode === "collapse-override" ? "collapse" : "hidden";
					for (const block of cache.querySelectorAll("h1, p, li")) {
						block.style.visibility = "visible";
					}
					if (offscreen) cache.style.marginTop = "10000px";
				} else if (embedded) {
					cache.hidden = true;
					embed.hidden = false;
					if (offscreen) embed.style.marginTop = "10000px";
				} else if (!mode.endsWith("ancestor")) {
					embed.hidden = false;
					if (mode === "display-none") gist.style.display = "none";
					if (mode === "visibility-hidden") gist.style.visibility = "hidden";
					if (mode === "content-visibility-hidden") {
						gist.style.contentVisibility = "hidden";
					}
					if (mode === "hidden-contents-text") gist.style.visibility = "hidden";
					if (mode === "hidden-contents-content") {
						for (const block of gist.querySelectorAll("h1, p, li")) {
							block.style.contentVisibility = "hidden";
						}
					}
				}

				let receive;
				window.chrome = {
					runtime: {
						onMessage: {
							addListener(fn) {
								receive = fn;
							},
							removeListener() {},
						},
						sendMessage: async () => ({}),
						getManifest: () => ({ version: "test" }),
					},
				};
				const { createContentRuntime } = await import("/src/content.js");
				const runtime = createContentRuntime();
				const send = (type, payload) => {
					let result;
					receive({ type, payload }, null, (value) => {
						result = value;
					});
					return result;
				};
				const start = () =>
					send("start-page-translation-session", {
						sessionId: "root-visibility",
						targetLanguage: "zh-TW",
					});
				const sources = [...visible.querySelectorAll("h1, p, li")];
				const originals = sources.map(
					(source) => runtime.__TEST__.getSegmentContent(source).text,
				);
				const first = start();
				let extraction = first;
				if (offscreen) {
					sources[0].scrollIntoView();
					extraction = start();
				}
				const render = () =>
					send("render-page-translation-updates", {
						translations: extraction.items.map((item) => ({
							id: item.id,
							sourceText: item.text,
							translation: "這是可見正文的測試翻譯。",
						})),
						targetLanguage: "zh-TW",
					});
				const rendered = [render().rendered, render().rendered];
				const repeat = start();
				const result = {
					expected: sources.length,
					total: first.totalSegments,
					initialItems: first.items.length,
					items: extraction.items.length,
					rendered,
					repeatItems: repeat.items.length,
					readyNotes: visible.querySelectorAll(
						'[data-ot-role="note"][data-phase="ready"]',
					).length,
					hiddenBound: hidden.querySelectorAll(
						'[data-ot-source-id], [data-ot-role="note"]',
					).length,
					relatedBound: document
						.querySelector("#related")
						.querySelectorAll('[data-ot-source-id], [data-ot-role="note"]')
						.length,
					notesVisible: [
						...visible.querySelectorAll('[data-ot-role="note"]'),
					].every(
						(note) =>
							note.checkVisibility({ visibilityProperty: true }) &&
							note.getBoundingClientRect().width > 0 &&
							note.getBoundingClientRect().height > 0,
					),
					originalsPreserved: sources.every(
						(source, index) =>
							runtime.__TEST__.getSegmentContent(source).text ===
							originals[index],
					),
					visibleScore: runtime.__TEST__.scoreTranslationRoot(visible),
					hiddenScore: runtime.__TEST__.scoreTranslationRoot(hidden),
					overflow: document.documentElement.scrollWidth > window.innerWidth,
				};
				runtime.cleanup();
				return result;
			}, mode);
			const label = `${mode} at ${width}px`;
			assert.equal(result.total, result.expected, label);
			assert.equal(result.items, result.expected, label);
			assert.deepEqual(
				result.rendered,
				[result.expected, result.expected],
				label,
			);
			assert.equal(result.repeatItems, 0, label);
			assert.equal(result.readyNotes, result.expected, label);
			assert.equal(result.hiddenBound, 0, label);
			assert.equal(result.relatedBound, 0, label);
			assert.equal(result.notesVisible, true, label);
			assert.equal(result.originalsPreserved, true, label);
			assert.ok(Number.isFinite(result.visibleScore), label);
			assert.equal(result.hiddenScore, Number.NEGATIVE_INFINITY, label);
			assert.equal(result.overflow, false, label);
			if (mode.startsWith("offscreen"))
				assert.equal(result.initialItems, 0, label);
			if (
				[
					"hidden-ancestor",
					"visible-embed",
					"contents-embed",
					"visibility-override",
				].includes(mode)
			) {
				await page.screenshot({
					path: path.join(artifactsDir, `root-visibility-${mode}-${width}.png`),
					fullPage: true,
					animations: "disabled",
				});
			}
		}
		console.log(`Root visibility regression passed at ${width}px`);
	}
}

module.exports = { checkRootVisibility };
