import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, test } from "vitest";

const script = path.resolve("scripts/sync-version.mjs");
const directories = [];

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function createFixture(version, manifestVersion = "0.1.3") {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), "pi-translator-version-"),
	);
	directories.push(directory);
	await writeFile(
		path.join(directory, "package.json"),
		JSON.stringify({ version }),
	);
	await writeFile(
		path.join(directory, "manifest.json"),
		JSON.stringify({
			manifest_version: 3,
			name: "Pi Translator",
			version: manifestVersion,
			permissions: ["storage"],
		}),
	);
	return directory;
}

function runSync(directory, ...args) {
	return spawnSync(process.execPath, [script, ...args], {
		cwd: directory,
		encoding: "utf8",
	});
}

test("version synchronization changes only the manifest version", async () => {
	const directory = await createFixture("0.2.0");
	const result = runSync(directory);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(
		JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")),
		{
			manifest_version: 3,
			name: "Pi Translator",
			version: "0.2.0",
			permissions: ["storage"],
		},
	);
	assert.equal(runSync(directory, "--check").status, 0);
});

test("version verification rejects a mismatch without rewriting the manifest", async () => {
	const directory = await createFixture("0.2.0");
	const before = await readFile(path.join(directory, "manifest.json"), "utf8");
	const result = runSync(directory, "--check");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Manifest version differs/u);
	assert.equal(
		await readFile(path.join(directory, "manifest.json"), "utf8"),
		before,
	);
});

test.each(["0.1.4-beta.1", "1.2", "01.2.3", "1.2.65536", "0.0.0", undefined])(
	"version synchronization rejects unsupported Chrome version %s",
	async (version) => {
		const directory = await createFixture(version);
		const result = runSync(directory);
		assert.notEqual(result.status, 0);
		assert.match(
			result.stderr,
			/Package version must be a stable Chrome version/u,
		);
	},
);

test("version synchronization accepts Chrome component limits", async () => {
	const directory = await createFixture("65535.65535.65535");
	const result = runSync(directory);
	assert.equal(result.status, 0, result.stderr);
});
