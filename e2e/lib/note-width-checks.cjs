const assert = require("node:assert/strict");
const { mkdir } = require("node:fs/promises");

async function checkNoteWidths(page, origin) {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(`${origin}/test/fixture-page.html`);
	await page.setContent(`
		<!doctype html>
		<style>
			body { margin: 20px; }
			main { border: 2px solid transparent; padding-inline: 24px; }
			main p { margin-block: 24px 10px; }
			#offset { max-width: 620px; margin-inline-start: 28%; padding-inline: 16px 8px; }
			#centered { max-width: 980px; margin-inline: auto; }
			#column { display: flex; flex-direction: column; align-items: center; }
			#fixed { width: min(520px, 90%); height: 48px; }
			#rtl { max-width: 980px; margin-inline-start: 10%; }
			@media (max-width: 640px) { #offset, #rtl { margin-inline-start: 0; } }
		</style>
		<main>
			<p id="offset">This paragraph is inset from the left edge of a wide article. Its translated note should stay in the same reading column.</p>
			<p id="centered">This centered paragraph is wider than the configured maximum translation width.</p>
			<div id="column"><p id="fixed">This paragraph has a fixed height and needs a sibling note even in a flex column.</p></div>
			<div dir="rtl"><p id="rtl" lang="ar">هذه فقرة عربية طويلة تبدأ من الحافة اليمنى، ويجب أن تبدأ الترجمة من الموضع نفسه.</p></div>
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
			["offset", "centered", "fixed", "rtl"].map((id) => {
				const source = document.getElementById(id);
				const note = source.nextElementSibling;
				const sourceRect = source.getBoundingClientRect();
				const noteRect = note?.getBoundingClientRect();
				const style = getComputedStyle(source);
				const left = sourceRect.left + Number.parseFloat(style.paddingLeft);
				const right = sourceRect.right - Number.parseFloat(style.paddingRight);
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
			});
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
		return { pending, placeholders, ready, notes: window.readNoteWidths() };
	});

	function assertAligned(notes, phase) {
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
			assert.ok(
				Math.abs(noteStart - start) <= 1,
				`${id}: ${noteStart} should match ${start}`,
			);
			assert.ok(
				Math.abs(noteWidth - Math.min(width, 720)) <= 1,
				`${id}: unexpected width ${noteWidth} for source ${width}`,
			);
			assert.equal(below, true, id);
		}
	}
	assert.equal(result.pending.rendered, 4);
	assert.equal(result.ready.rendered, 4);
	assertAligned(result.placeholders, "pending");
	assertAligned(result.notes, "ready");
	await mkdir("e2e-artifacts", { recursive: true });
	await page.screenshot({
		path: "e2e-artifacts/note-width-1440.png",
		fullPage: true,
		animations: "disabled",
	});

	await page.setViewportSize({ width: 390, height: 1000 });
	await page.waitForFunction(() => window.readNoteWidths()[0].noteStart < 100);
	assertAligned(await page.evaluate(() => window.readNoteWidths()), "ready");
	assert.equal(await page.locator('[data-ot-role="note"]').count(), 4);
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
