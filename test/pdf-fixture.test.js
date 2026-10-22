import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

import { createPdfFixture } from "../e2e/lib/pdf-fixture.cjs";

import {
	analyzePdfPage,
	removeRepeatedFurniture,
} from "../src/pdf/extraction.js";

import { getPdfHighlightBounds } from "../src/pdf/reader-utils.js";

const fixtureUrl = new URL("./fixtures/pdf/two-column.pdf", import.meta.url);
const encryptedUrl = new URL("./fixtures/pdf/encrypted.pdf", import.meta.url);

async function loadPdf(fileUrl, password) {
	const { VerbosityLevel, getDocument } = await import(
		"pdfjs-dist/legacy/build/pdf.mjs"
	);
	const task = getDocument({
		verbosity: VerbosityLevel.ERRORS,
		data: new Uint8Array(
			fileUrl instanceof Uint8Array ? fileUrl : await readFile(fileUrl),
		),
		isEvalSupported: false,
		standardFontDataUrl: new URL(
			"../node_modules/pdfjs-dist/standard_fonts/",
			import.meta.url,
		).toString(),
	});
	if (password) {
		task.onPassword = (updatePassword) => updatePassword(password);
	}
	return { document: await task.promise, task };
}

test("navigation PDF fixture exposes six independently translatable pages", async () => {
	const { document, task } = await loadPdf(createPdfFixture());
	try {
		assert.equal(document.numPages, 6);
		for (let number = 1; number <= 6; number += 1) {
			const page = await document.getPage(number);
			const content = await page.getTextContent();
			const blocks = analyzePdfPage({
				documentId: "navigation",
				items: content.items,
				pageNumber: number,
				pageWidth: 612,
			});
			assert.ok(blocks.length >= 8);
			assert.match(
				blocks.map((block) => block.text).join(" "),
				new RegExp(`Navigation page ${number}`),
			);
			assert.equal(
				blocks.some((block) => block.originalOnly),
				false,
			);
		}
	} finally {
		await task.destroy();
	}
});

test("project PDF fixture exposes three text pages in column order", async () => {
	const { document, task } = await loadPdf(fixtureUrl);
	try {
		assert.equal(document.numPages, 3);
		const pages = [];
		for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
			const page = await document.getPage(pageNumber);
			const viewport = page.getViewport({ scale: 1 });
			const textContent = await page.getTextContent();
			pages.push({
				blocks: analyzePdfPage({
					documentId: "fixture",
					items: textContent.items,
					pageNumber,
					pageWidth: viewport.width,
				}),
				height: viewport.height,
				pageNumber,
			});
		}
		const filtered = removeRepeatedFurniture(pages);
		const firstPage = filtered[0].blocks.map((block) => block.text).join(" ");
		assert.match(firstPage, /Computational thinking/);
		assert.match(firstPage, /computational should be joined/);
		assert.ok(
			firstPage.indexOf("Computational thinking") <
				firstPage.indexOf("The right column"),
		);
		assert.equal(firstPage.includes("Repeated footer"), false);
		assert.equal(
			filtered[0].blocks.some(
				(block) => block.originalOnly && /formula/.test(block.text),
			),
			true,
		);
	} finally {
		await task.destroy();
	}
});

test("PDF highlights use supported viewport point transforms at different rotations", async () => {
	const { document, task } = await loadPdf(fixtureUrl);
	try {
		const page = await document.getPage(1);
		const box = { x: 10, y: 20, width: 30, height: 40 };
		const viewport = page.getViewport({ scale: 2 });
		assert.deepEqual(getPdfHighlightBounds(viewport, box), {
			left: 20,
			top: viewport.height - 120,
			width: 60,
			height: 80,
		});
		assert.deepEqual(
			getPdfHighlightBounds(page.getViewport({ scale: 2, rotation: 90 }), box),
			{
				left: 40,
				top: 20,
				width: 80,
				height: 60,
			},
		);
	} finally {
		await task.destroy();
	}
});

test("encrypted PDF fixture opens only with the documented test password", async () => {
	const { document, task } = await loadPdf(encryptedUrl, "vibe-test");
	try {
		assert.equal(document.numPages, 3);
		const page = await document.getPage(1);
		const text = (await page.getTextContent()).items
			.map((item) => item.str)
			.join(" ");
		assert.match(text, /Vibe Translator PDF Fixture/);
	} finally {
		await task.destroy();
	}
});
