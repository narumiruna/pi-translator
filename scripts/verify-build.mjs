import assert from "node:assert/strict";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import process from "node:process";

import { init, parse } from "es-module-lexer";

const rootDir = path.resolve(import.meta.dirname, "..");
const buildDir = path.join(rootDir, "dist", "chrome");
const baselinePath = path.join(
	rootDir,
	"test",
	"fixtures",
	"manifest-baseline.json",
);
const maximumBackgroundBytes = 1_450_000;
const maximumOptionsBytes = 950_000;
const maximumPdfBytes = 1_700_000;
const maximumUnpackedBytes = 4_100_000;
const nodeBuiltinModules = new Set(
	builtinModules.map((moduleName) => moduleName.replace(/^node:/u, "")),
);
const forbiddenPathPatterns = [
	/(^|\/)node_modules\//u,
	/(^|\/)test(s)?\//u,
	/(^|\/)src\//u,
	/(^|\/)\.env(?:\.|$)/u,
	/(^|\/)extension-env\.d\.ts$/u,
	/\.map$/u,
];

async function readJson(filePath) {
	return JSON.parse(await readFile(filePath, "utf8"));
}

async function listFiles(directory, prefix = "") {
	const files = [];

	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const relativePath = path.posix.join(prefix, entry.name);
		const absolutePath = path.join(directory, entry.name);

		if (entry.isDirectory()) {
			files.push(...(await listFiles(absolutePath, relativePath)));
		} else if (entry.isFile()) {
			files.push(relativePath);
		}
	}

	return files.sort();
}

function normalizeManifest(manifest) {
	const contentScript = manifest.content_scripts?.[0] || {};

	return {
		action: manifest.action,
		contentScript: {
			matches: contentScript.matches,
			run_at: contentScript.run_at,
		},
		description: manifest.description,
		host_permissions: manifest.host_permissions,
		manifest_version: manifest.manifest_version,
		name: manifest.name,
		optional_host_permissions: manifest.optional_host_permissions,
		permissions: manifest.permissions,
		sidePanel: manifest.side_panel,
		version: manifest.version,
	};
}

function getReferencedPaths(manifest) {
	return [
		manifest.background?.service_worker,
		manifest.options_page || manifest.options_ui?.page,
		manifest.side_panel?.default_path,
		...Object.values(manifest.icons || {}),
		...Object.values(manifest.action?.default_icon || {}),
		...(manifest.content_scripts || []).flatMap((entry) => [
			...(entry.js || []),
			...(entry.css || []),
		]),
	].filter(Boolean);
}

function isNodeBuiltinSpecifier(specifier) {
	const normalized = specifier.replace(/^node:/u, "");
	return specifier.startsWith("node:") || nodeBuiltinModules.has(normalized);
}

async function verifyBuild() {
	await init;
	const manifestPath = path.join(buildDir, "manifest.json");
	const [manifest, baseline, packageJson, files] = await Promise.all([
		readJson(manifestPath),
		readJson(baselinePath),
		readJson(path.join(rootDir, "package.json")),
		listFiles(buildDir),
	]);

	assert.deepEqual(
		normalizeManifest(manifest),
		{ ...baseline, version: packageJson.version },
		"Generated manifest behavior differs from the reviewed baseline.",
	);
	assert.equal(
		manifest.background?.type,
		"module",
		"Background service worker must be emitted as a module.",
	);
	assert.equal(
		manifest.content_scripts?.length,
		1,
		"Exactly one manifest content-script entry is expected.",
	);
	assert.equal(
		manifest.content_scripts?.[0]?.js?.length,
		1,
		"The content entry must resolve to one bundled JavaScript file.",
	);

	for (const referencedPath of new Set(getReferencedPaths(manifest))) {
		await access(path.join(buildDir, referencedPath));
	}

	const nestedZips = files.filter((file) => file.endsWith(".zip"));
	assert.ok(
		nestedZips.length <= 1,
		`Unexpected nested ZIP files: ${nestedZips.join(", ")}`,
	);
	assert.equal(
		files.filter(
			(file) => file.startsWith("content_scripts/") && file.endsWith(".js"),
		).length,
		1,
		"The artifact must contain exactly one content JavaScript bundle.",
	);

	const forbiddenFiles = files.filter((file) =>
		forbiddenPathPatterns.some((pattern) => pattern.test(file)),
	);
	assert.deepEqual(
		forbiddenFiles,
		[],
		`Development-only files were emitted: ${forbiddenFiles.join(", ")}`,
	);

	const JavaScriptFiles = files.filter((file) => file.endsWith(".js"));
	for (const file of JavaScriptFiles) {
		const source = await readFile(path.join(buildDir, file), "utf8");
		assert.doesNotMatch(
			source,
			/\bimportScripts\s*\(/u,
			`${file} uses importScripts().`,
		);
		assert.doesNotMatch(
			source,
			/webpackHotUpdate|__webpack_hmr__|sockjs-node/iu,
			`${file} contains a development reload runtime.`,
		);
		const [imports] = parse(source);
		const nodeImport = imports.find(
			(imported) => imported.n && isNodeBuiltinSpecifier(imported.n),
		);
		assert.equal(
			nodeImport,
			undefined,
			`${file} imports Node-only module ${nodeImport?.n}.`,
		);
	}

	const fileSizes = new Map(
		await Promise.all(
			files
				.filter((file) => !file.endsWith(".zip"))
				.map(async (file) => [
					file,
					(await stat(path.join(buildDir, file))).size,
				]),
		),
	);
	const backgroundBytes =
		fileSizes.get(manifest.background.service_worker) || 0;
	const optionsBytes = Array.from(fileSizes)
		.filter(([file]) => file.startsWith("options/"))
		.reduce((sum, [, size]) => sum + size, 0);
	const rootJavaScriptFiles = files.filter(
		(file) => !file.includes("/") && file.endsWith(".js"),
	);
	const pdfWorkerFiles = [];
	for (const file of rootJavaScriptFiles) {
		const source = await readFile(path.join(buildDir, file), "utf8");
		if (!source.includes("rspackChunk")) {
			pdfWorkerFiles.push(file);
		}
	}
	assert.equal(
		pdfWorkerFiles.length,
		1,
		`Expected one standalone bundled PDF worker, found: ${pdfWorkerFiles.join(", ")}`,
	);
	const pdfBytes = Array.from(fileSizes)
		.filter(
			([file]) => file.startsWith("sidebar/") || pdfWorkerFiles.includes(file),
		)
		.reduce((sum, [, size]) => sum + size, 0);
	const unpackedBytes = Array.from(fileSizes.values()).reduce(
		(sum, size) => sum + size,
		0,
	);

	assert.ok(
		backgroundBytes <= maximumBackgroundBytes,
		`Background artifact is ${backgroundBytes} bytes; budget is ${maximumBackgroundBytes}.`,
	);
	assert.ok(
		optionsBytes <= maximumOptionsBytes,
		`Options artifact is ${optionsBytes} bytes; budget is ${maximumOptionsBytes}.`,
	);
	assert.ok(
		pdfBytes <= maximumPdfBytes,
		`PDF reader artifact is ${pdfBytes} bytes; budget is ${maximumPdfBytes}.`,
	);
	assert.ok(
		unpackedBytes <= maximumUnpackedBytes,
		`Unpacked artifact is ${unpackedBytes} bytes; budget is ${maximumUnpackedBytes}.`,
	);

	console.log(
		`Verified dist/chrome: ${files.length} files, ${unpackedBytes} unpacked bytes, manifest ${manifest.version}.`,
	);
}

verifyBuild().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
