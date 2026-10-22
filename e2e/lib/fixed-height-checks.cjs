const assert = require("node:assert/strict");
const { mkdir } = require("node:fs/promises");

async function checkFixedHeights(page, origin) {
	for (const width of [1440, 390]) {
		await page.setViewportSize({ width, height: 1000 });
		await page.goto(`${origin}/test/fixture-page.html`);
		await page.setContent(`
			<style>
				.column { display:flex; flex-direction:column; width:min(350px, 100%); }
				.fixed { height:24px; flex-shrink:0; }
				.basis { flex:0 0 24px; min-height:0; }
				p { margin:0; }
			</style>
			<main>
				<div class="column">
					<p id="fixed" class="fixed">This fixed height paragraph needs a safe sibling translation.</p>
					<p id="basis" class="basis">This fixed flex basis paragraph also needs a safe sibling translation.</p>
					<p id="auto">This auto height paragraph can grow to contain its translation.</p>
				</div>
				<div style="display:grid"><p id="grid" style="block-size:24px">This fixed height grid item must stay out of the translation queue.</p></div>
				<table><tbody><tr><td id="cell" class="fixed">This fixed height table cell must not create a note under the row.</td></tr></tbody></table>
			</main>
		`);
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
			const send = (type, payload) => {
				let response;
				receive({ type, payload }, null, (value) => {
					response = value;
				});
				return response;
			};
			const start = () =>
				send("start-page-translation-session", {
					sessionId: "fixed-height",
					targetLanguage: "en",
				});
			const fixed = document.querySelector("#fixed");
			const basis = document.querySelector("#basis");
			const auto = document.querySelector("#auto");
			const grid = document.querySelector("#grid");
			const cell = document.querySelector("#cell");
			const sources = [fixed, basis, auto, grid, cell];
			const stylesBefore = sources.map((source) =>
				source.getAttribute("style"),
			);
			const first = start();
			const blockedUnbound = [grid, cell].every(
				(source) =>
					!source.hasAttribute("data-ot-source-id") &&
					!source.hasAttribute("data-ot-queued"),
			);
			const render = () =>
				send("render-page-translation-updates", {
					translations: first.items.map((item) => ({
						id: item.id,
						sourceText: item.text,
						translation: "This is a long test translation. ".repeat(8),
					})),
					targetLanguage: "en",
				});
			const rendered = [render().rendered, render().rendered];
			const note = fixed.nextElementSibling;
			const sibling =
				note?.getAttribute("data-ot-role") === "note" && !fixed.contains(note);
			const basisNote = basis.nextElementSibling;
			const basisSibling =
				basisNote?.getAttribute("data-ot-role") === "note" &&
				!basis.contains(basisNote);
			const noOverlap =
				sibling &&
				basisSibling &&
				note.getBoundingClientRect().top >=
					fixed.getBoundingClientRect().bottom &&
				basis.getBoundingClientRect().top >=
					note.getBoundingClientRect().bottom &&
				basisNote.getBoundingClientRect().top >=
					basis.getBoundingClientRect().bottom &&
				auto.getBoundingClientRect().top >=
					basisNote.getBoundingClientRect().bottom;
			const autoChild =
				auto.querySelectorAll("[data-ot-role='note']").length === 1;
			const repeatCount = start().items.length;
			const stylesUnchanged = sources.every(
				(source, index) => source.getAttribute("style") === stylesBefore[index],
			);
			// A height change must also move an existing note without duplication.
			fixed.style.height = "auto";
			window.dispatchEvent(new Event("resize"));
			const child = fixed.querySelector("[data-ot-role='note']");
			const recoveredChild = child?.tagName === "SPAN";
			fixed.style.removeProperty("height");
			window.dispatchEvent(new Event("resize"));
			const restoredSibling =
				fixed.nextElementSibling?.tagName === "P" && !fixed.contains(child);
			const count = document.querySelectorAll("[data-ot-role='note']").length;
			grid.style.blockSize = "auto";
			cell.style.height = "auto";
			const recoveredCount = start().items.length;
			const validRows = [...document.querySelectorAll("tr > *")].every(
				(element) => element.tagName === "TD",
			);
			runtime.cleanup();
			return {
				firstCount: first.items.length,
				blockedUnbound,
				rendered,
				sibling,
				noOverlap,
				autoChild,
				repeatCount,
				stylesUnchanged,
				recoveredChild,
				restoredSibling,
				count,
				recoveredCount,
				validRows,
			};
		});
		assert.equal(result.firstCount, 3);
		assert.equal(result.blockedUnbound, true);
		assert.deepEqual(result.rendered, [3, 3]);
		assert.equal(result.sibling, true);
		assert.equal(result.noOverlap, true);
		assert.equal(result.autoChild, true);
		assert.equal(result.repeatCount, 0);
		assert.equal(result.stylesUnchanged, true);
		assert.equal(result.recoveredChild, true);
		assert.equal(result.restoredSibling, true);
		assert.equal(result.count, 3);
		assert.equal(result.recoveredCount, 2);
		assert.equal(result.validRows, true);
		await mkdir("e2e-artifacts", { recursive: true });
		await page.screenshot({
			path: `e2e-artifacts/fixed-height-${width}.png`,
			fullPage: true,
		});
		console.log(`Fixed-height placement passed at ${width}px`);
	}
}

module.exports = { checkFixedHeights };
