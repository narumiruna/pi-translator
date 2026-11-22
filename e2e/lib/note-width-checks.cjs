const assert = require("node:assert/strict");
const { mkdir } = require("node:fs/promises");

async function checkNoteWidths(page, origin) {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(`${origin}/test/note-width-page.html`);
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
		const appearance = { presetId: "custom", inline: { maxWidthPx: 720 } };
		const session = send("start-page-translation-session", {
			sessionId: "note-width",
			targetLanguage: "zh-TW",
			translationAppearance: appearance,
		});
		const pending = send("render-page-placeholders", {
			ids: session.items.map(({ id }) => id),
			targetLanguage: "zh-TW",
		});
		window.readNoteWidths = () =>
			["offset", "centered", "fixed", "rtl", "mixed", "multicol-source"].map(
				(id) => {
					const source = document.getElementById(id);
					const note = source.nextElementSibling;
					const sourceRect = source.getBoundingClientRect();
					const noteRect = note?.getBoundingClientRect();
					const style = getComputedStyle(source);
					const left = sourceRect.left + Number.parseFloat(style.paddingLeft);
					const right =
						sourceRect.right - Number.parseFloat(style.paddingRight);
					return {
						id,
						phase: note?.getAttribute("data-phase"),
						start: style.direction === "rtl" ? right : left,
						noteStart:
							style.direction === "rtl" ? noteRect?.right : noteRect?.left,
						width: right - left,
						noteWidth: noteRect?.width,
						below: noteRect?.top >= sourceRect.bottom,
					};
				},
			);
		const placeholders = window.readNoteWidths();
		const ready = send("render-page-translation-updates", {
			translations: session.items.map(({ id, text }) => ({
				id,
				sourceText: text,
				translation: "這是用於確認欄寬和換行方式的測試譯文。".repeat(8),
			})),
			targetLanguage: "zh-TW",
		});
		window.cleanupNoteWidths = runtime.cleanup;
		const boundHiddenHeadings = ["hidden-inset", "hidden-rect"].filter((id) =>
			document.getElementById(id).hasAttribute("data-ot-source-id"),
		);
		return {
			boundHiddenHeadings,
			pending,
			placeholders,
			ready,
			notes: window.readNoteWidths(),
		};
	});

	function alignmentErrors(notes, phase) {
		const errors = [];
		for (const {
			id,
			start,
			noteStart,
			width,
			noteWidth,
			below,
			...note
		} of notes) {
			assert.equal(note.phase, phase, id);
			if (Math.abs(noteStart - start) > 1) {
				errors.push(`${id}: ${noteStart} should match ${start}`);
			}
			if (Math.abs(noteWidth - Math.min(width, 720)) > 1) {
				errors.push(`${id}: unexpected width ${noteWidth} for source ${width}`);
			}
			if (!below) errors.push(`${id}: note should be below the source`);
		}
		return errors;
	}
	assert.deepEqual(result.boundHiddenHeadings, []);
	assert.equal(result.pending.rendered, 6);
	assert.equal(result.ready.rendered, 6);
	assert.ok(
		result.notes.find(({ id }) => id === "multicol-source").start > 700,
	);
	await mkdir("e2e-artifacts", { recursive: true });
	await page.screenshot({
		path: "e2e-artifacts/note-width-1440.png",
		fullPage: true,
		animations: "disabled",
	});

	const scaled = await page.evaluate(() => {
		const source = document.querySelector("#offset");
		const note = source.nextElementSibling;
		return [document.body, document.documentElement].map((ancestor) => {
			ancestor.style.transform = "scale(.8)";
			window.dispatchEvent(new Event("resize"));
			const width = note.getBoundingClientRect().width;
			ancestor.style.removeProperty("transform");
			return width;
		});
	});
	assert.deepEqual(
		[
			...alignmentErrors(result.placeholders, "pending"),
			...alignmentErrors(result.notes, "ready"),
			...scaled
				.filter((width) => Math.abs(width - 576) > 1)
				.map((width) => `Expected default width under scale, got ${width}`),
		],
		[],
	);

	await page.setViewportSize({ width: 390, height: 1000 });
	await page.waitForFunction(() => window.readNoteWidths()[0].noteStart < 100);
	assert.deepEqual(
		alignmentErrors(
			await page.evaluate(() => window.readNoteWidths()),
			"ready",
		),
		[],
	);
	assert.equal(await page.locator('[data-ot-role="note"]').count(), 6);
	assert.equal(
		await page.evaluate(() => document.documentElement.scrollWidth),
		390,
	);
	await page.screenshot({
		path: "e2e-artifacts/note-width-390.png",
		fullPage: true,
		animations: "disabled",
	});
	await page.evaluate(() => window.cleanupNoteWidths());
	console.log(
		"Source-column note alignment passed at 1440px and after resizing to 390px",
	);
}

module.exports = { checkNoteWidths };
