import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const version = packageJson.version;

if (
	typeof version !== "string" ||
	!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version) ||
	version.split(".").some((part) => Number(part) > 65535) ||
	version === "0.0.0"
) {
	throw new Error(
		"Package version must be a stable Chrome version (three integers from 0 to 65535, not all zero).",
	);
}

if (process.argv.includes("--check")) {
	if (manifest.version !== version) {
		throw new Error(
			"Manifest version differs from package.json. Run npm run version.",
		);
	}
} else {
	manifest.version = version;
	await writeFile("manifest.json", `${JSON.stringify(manifest, null, "\t")}\n`);
}
