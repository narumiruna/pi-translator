const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright");
const { createStaticServer } = require("./lib/extension-test-helpers.cjs");

async function main() {
	const server = await createStaticServer(path.resolve(__dirname, ".."));
	let browser;
	try {
		browser = await chromium.launch({ headless: true });
		const page = await browser.newPage();
		for (const width of [1440, 390]) {
			await page.setViewportSize({ width, height: 1000 });
			await page.goto(`${server.origin}/test/layout-page.html`);
			const result = await page.evaluate(async () => {
				const { createContentRuntime } = await import("/src/content.js");
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
				const runtime = createContentRuntime();
				const sources = [...document.querySelectorAll("[data-test-source]")];
				const bounds = () =>
					sources.map((e) => ({
						left: e.getBoundingClientRect().left,
						width: e.getBoundingClientRect().width,
					}));
				const before = bounds();
				const translations = sources.map((element, i) => {
					element.setAttribute("data-ot-source-id", `ot-${i}`);
					return {
						id: `ot-${i}`,
						translation: "這是翻譯內容，用於驗證排版維持正常。".repeat(4),
					};
				});
				const render = () => {
					let response;
					receive(
						{
							type: "render-page-translation-updates",
							payload: { translations, targetLanguage: "zh-TW" },
						},
						null,
						(value) => {
							response = value;
						},
					);
					return response;
				};
				const first = render();
				const second = render();
				const after = bounds();
				const count = document.querySelectorAll("[data-ot-role='note']").length;
				const inside = sources.every((e) => {
					if (e.hasAttribute("data-test-external")) {
						return (
							!e.querySelector("[data-ot-role='note']") &&
							e.nextElementSibling?.getAttribute("data-ot-role") === "note"
						);
					}
					return e.querySelectorAll("[data-ot-role='note']").length === 1;
				});
				const placementSources = [
					document.querySelector("#placement-paragraph"),
					document.querySelector("#placement-item"),
				];
				const originalTags = placementSources.map(
					(source) => source.nextElementSibling.tagName,
				);
				const originalBodies = placementSources.map((source) =>
					source.nextElementSibling.querySelector("[data-ot-role='note-body']"),
				);
				const placementFlow = document.querySelector("#placement-flow");
				const placementList = document.querySelector("#placement-list");
				placementFlow.style.display = "grid";
				placementList.style.display = "flex";
				placementList.style.flexDirection = "column";
				window.dispatchEvent(new Event("resize"));
				const childMode = placementSources.every((source, index) => {
					const note = source.querySelector("[data-ot-role='note']");
					return (
						note?.tagName === "SPAN" &&
						note.getAttribute("data-phase") === "ready" &&
						note.getAttribute("data-lang") === "zh-TW" &&
						note.querySelector("[data-ot-role='note-body']") ===
							originalBodies[index] &&
						note.getBoundingClientRect().width > 1
					);
				});
				render();
				placementFlow.style.removeProperty("display");
				placementList.style.removeProperty("display");
				window.dispatchEvent(new Event("resize"));
				const siblingMode = placementSources.every((source, index) => {
					const note = source.nextElementSibling;
					return (
						!source.querySelector("[data-ot-role='note']") &&
						note?.tagName === originalTags[index] &&
						note.querySelector("[data-ot-role='note-body']") ===
							originalBodies[index]
					);
				});
				render();
				const placementCount = document.querySelectorAll(
					"[data-ot-role='note']",
				).length;
				const clipped = document.querySelector("#clipped-source");
				const externalVisible =
					clipped.nextElementSibling.getBoundingClientRect().top >=
					clipped.getBoundingClientRect().bottom;
				const row = document.querySelector("#flex-source");
				const rowVisible =
					row.nextElementSibling.getBoundingClientRect().top >=
					row.getBoundingClientRect().bottom;
				const fallbackNotes = [
					...document.querySelectorAll(".review-cases [data-ot-role='note']"),
				];
				const reviewCases = document.querySelector(".review-cases");
				reviewCases.style.flexDirection = "row";
				window.dispatchEvent(new Event("resize"));
				const unsafeHidden = fallbackNotes.every(
					(note) => getComputedStyle(note).display === "none",
				);
				reviewCases.style.flexDirection = "column";
				window.dispatchEvent(new Event("resize"));
				const restored = fallbackNotes.every(
					(note) => getComputedStyle(note).display !== "none",
				);
				const sourceText = runtime.__TEST__.getSegmentContent(sources[1]).text;
				sources[1].firstChild.textContent =
					"Updated dynamic salary: $25–$80/hr.";
				translations[1].translation = "更新後的薪資：$25–$80/hr。";
				render();
				const dynamicCount = sources[1].querySelectorAll(
					"[data-ot-role='note']",
				).length;
				const dynamicText = sources[1].querySelector(
					"[data-ot-role='note-body']",
				).textContent;
				const updatedSourceText = runtime.__TEST__.getSegmentContent(
					sources[1],
				).text;
				const overflow =
					document.documentElement.scrollWidth > window.innerWidth;
				document.querySelector("#action").click();
				const action = document.querySelector("#action").textContent;
				runtime.cleanup();
				reviewCases.style.flexDirection = "row";
				window.dispatchEvent(new Event("resize"));
				const cleanupStable = fallbackNotes.every(
					(note) => getComputedStyle(note).display !== "none",
				);
				reviewCases.style.flexDirection = "column";
				return {
					before,
					after,
					first,
					second,
					count,
					inside,
					originalTags,
					childMode,
					siblingMode,
					placementCount,
					externalVisible,
					rowVisible,
					unsafeHidden,
					restored,
					cleanupStable,
					sourceText,
					dynamicCount,
					dynamicText,
					updatedSourceText,
					overflow,
					action,
				};
			});
			assert.equal(result.first.rendered, 8);
			assert.equal(result.second.rendered, 8);
			assert.deepEqual(result.after, result.before);
			assert.equal(result.count, 8);
			assert.equal(result.inside, true);
			assert.deepEqual(result.originalTags, ["P", "LI"]);
			assert.equal(result.childMode, true);
			assert.equal(result.siblingMode, true);
			assert.equal(result.placementCount, 8);
			assert.equal(result.externalVisible, true);
			assert.equal(result.rowVisible, true);
			assert.equal(result.unsafeHidden, true);
			assert.equal(result.restored, true);
			assert.equal(result.cleanupStable, true);
			assert.equal(result.dynamicCount, 1);
			assert.equal(result.dynamicText, "更新後的薪資：$25–$80/hr。");
			assert.equal(
				result.updatedSourceText,
				"Updated dynamic salary: $25–$80/hr.",
			);
			assert.equal(result.overflow, false);
			assert.equal(result.action, "Clicked");
			assert.equal(
				result.sourceText,
				"Salary ranges: $50–$150/hr, $35–$120/hr, and $25–$80/hr.",
			);
			console.log(`Layout regression passed at ${width}px`);
		}
	} finally {
		try {
			await browser?.close();
		} finally {
			await server.close();
		}
	}
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
