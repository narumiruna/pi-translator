const assert = require("node:assert/strict");

async function checkPlacementSafety(page, origin) {
	await page.goto(`${origin}/test/fixture-page.html`);
	await page.setContent(`
		<main>
			<table><tbody><tr>
				<td id="unsafe-cell" style="overflow:hidden">This constrained table cell contains enough readable original text to qualify for page translation.</td>
				<td id="safe-cell">This ordinary table cell contains enough readable original text to qualify for page translation.</td>
			</tr></tbody></table>
			<div style="display:grid"><p id="unsafe-grid" style="display:flex;overflow:hidden">This clipped flex item in a grid cannot safely accept a translated note inside or beside its source.</p></div>
			<p id="safe-paragraph">This normal paragraph can safely follow a translated note without changing the page layout.</p>
		</main>
	`);
	const mixed = await page.evaluate(async () => {
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
			let result;
			receive({ type, payload }, null, (value) => {
				result = value;
			});
			return result;
		};
		const start = () =>
			send("start-page-translation-session", {
				sessionId: "placement",
				targetLanguage: "zh-TW",
			});
		const render = (items) => {
			const pending = send("render-page-placeholders", {
				ids: items.map((item) => item.id),
				targetLanguage: "zh-TW",
			});
			const ready = send("render-page-translation-updates", {
				translations: items.map((item) => ({
					id: item.id,
					translation: "這是安全的測試翻譯。",
				})),
				targetLanguage: "zh-TW",
			});
			return [pending.rendered, ready.rendered];
		};
		const cell = document.querySelector("#unsafe-cell");
		const grid = document.querySelector("#unsafe-grid");
		const first = start();
		const skippedUnbound = [cell, grid].every(
			(source) =>
				!source.hasAttribute("data-ot-source-id") &&
				!source.hasAttribute("data-ot-queued"),
		);
		const firstRendered = render(first.items);
		const repeat = start();
		const validRows = () =>
			[...document.querySelectorAll("tr > *")].every((child) =>
				["TD", "TH"].includes(child.tagName),
			);
		const initialRowsValid = validRows();
		const safeCell = document.querySelector("#safe-cell");
		const safeNote = safeCell.querySelector("[data-ot-role='note']");
		safeCell.style.overflow = "hidden";
		window.dispatchEvent(new Event("resize"));
		const constrainedNoteHidden =
			safeCell.contains(safeNote) &&
			getComputedStyle(safeNote).display === "none" &&
			validRows();
		safeCell.style.overflow = "visible";
		window.dispatchEvent(new Event("resize"));
		const cellNoteRestored =
			safeCell.contains(safeNote) &&
			getComputedStyle(safeNote).display !== "none";
		cell.style.overflow = "visible";
		grid.style.display = "block";
		grid.style.overflow = "visible";
		const recovered = start();
		const recoveredRendered = render(recovered.items);
		const final = start();
		const finalRowsValid = validRows();
		const allNotesVisible = [
			...document.querySelectorAll("[data-ot-role='note']"),
		].every((note) => getComputedStyle(note).display !== "none");
		runtime.cleanup();
		return {
			firstCount: first.items.length,
			skippedUnbound,
			firstRendered,
			repeatCount: repeat.items.length,
			initialRowsValid,
			constrainedNoteHidden,
			cellNoteRestored,
			recoveredCount: recovered.items.length,
			recoveredRendered,
			finalCount: final.items.length,
			finalRowsValid,
			allNotesVisible,
		};
	});
	assert.equal(mixed.firstCount, 2);
	assert.equal(mixed.skippedUnbound, true);
	assert.deepEqual(mixed.firstRendered, [2, 2]);
	assert.equal(mixed.repeatCount, 0);
	assert.equal(mixed.initialRowsValid, true);
	assert.equal(mixed.constrainedNoteHidden, true);
	assert.equal(mixed.cellNoteRestored, true);
	assert.equal(mixed.recoveredCount, 2);
	assert.deepEqual(mixed.recoveredRendered, [2, 2]);
	assert.equal(mixed.finalCount, 0);
	assert.equal(mixed.finalRowsValid, true);
	assert.equal(mixed.allNotesVisible, true);

	await page.goto(`${origin}/test/fixture-page.html`);
	await page.setContent(
		`<main><div style="display:grid"><p id="blocked" style="display:flex;overflow:hidden">This clipped flex item is the only readable source and must not enter either extraction queue.</p></div></main>`,
	);
	const fallback = await page.evaluate(async () => {
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
		let walkers = 0;
		const createTreeWalker = document.createTreeWalker.bind(document);
		document.createTreeWalker = (...args) => {
			walkers += 1;
			return createTreeWalker(...args);
		};
		const start = () => {
			let result;
			receive(
				{
					type: "start-page-translation-session",
					payload: { sessionId: "fallback", targetLanguage: "zh-TW" },
				},
				null,
				(value) => {
					result = value;
				},
			);
			return result;
		};
		const counts = [start().items.length, start().items.length];
		const source = document.querySelector("#blocked");
		const unbound =
			!source.hasAttribute("data-ot-source-id") &&
			!source.hasAttribute("data-ot-queued");
		source.style.display = "block";
		source.style.overflow = "visible";
		const recoveredCount = start().items.length;
		document.createTreeWalker = createTreeWalker;
		runtime.cleanup();
		return { counts, unbound, walkers, recoveredCount };
	});
	assert.deepEqual(fallback.counts, [0, 0]);
	assert.equal(fallback.unbound, true);
	assert.ok(
		fallback.walkers >= 2,
		"Exercise fallback extraction on each blocked collection",
	);
	assert.equal(fallback.recoveredCount, 1);
	console.log(
		"Placement safety passed for tables, semantic extraction, fallback extraction, and layout recovery",
	);
}

module.exports = { checkPlacementSafety };
