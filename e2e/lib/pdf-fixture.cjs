// Project-owned PDF bytes generated without binary fixtures or external tools.
function createPdfFixture({ label = "Navigation", pageCount = 6 } = {}) {
	const objects = [];
	const add = (value) => {
		objects.push(value);
		return objects.length;
	};
	const catalog = add("");
	const pages = add("");
	const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	const info = add(`<< /Title (${label} fixture) >>`);
	const children = [];
	for (let number = 1; number <= pageCount; number += 1) {
		const lines = [`BT /F1 18 Tf 60 740 Td (${label} page ${number}) Tj ET`];
		for (let paragraph = 1; paragraph <= 8; paragraph += 1) {
			const y = 690 - (paragraph - 1) * 72;
			lines.push(
				`BT /F1 12 Tf 60 ${y} Td (${label} page ${number}, paragraph ${paragraph}: reliable document translation.) Tj`,
			);
			lines.push(
				"0 -18 Td (The reader renders the source and translates each paragraph once.) Tj ET",
			);
		}
		const stream = `${lines.join("\n")}\n`;
		const content = add(
			`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
		);
		children.push(
			add(
				`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
			),
		);
	}
	objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
	objects[pages - 1] =
		`<< /Type /Pages /Kids [${children.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`;
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	for (let index = 0; index < objects.length; index += 1) {
		offsets.push(Buffer.byteLength(pdf));
		pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
	}
	const xref = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
	pdf += offsets
		.slice(1)
		.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
		.join("");
	pdf += `trailer\n<< /Size ${offsets.length} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(pdf);
}

module.exports = { createPdfFixture };
