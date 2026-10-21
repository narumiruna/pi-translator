import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "vitest";

const require = createRequire(import.meta.url);
const {
	createWorkerStopper,
	getExtensionWorker,
} = require("../e2e/lib/youtube-fixture.cjs");

test("restart probes target the extension even when YouTube registers a later worker", async () => {
	function worker(url) {
		let marker;
		return {
			url: () => url,
			async evaluate(_callback, value) {
				if (value !== undefined) marker = value;
				return marker;
			},
		};
	}
	const prefix = "chrome-extension://extension/";
	const original = worker(`${prefix}background/service_worker.js`);
	const website = worker("https://www.youtube.com/sw.js");
	let workers = [original, website];
	assert.equal(
		getExtensionWorker({ serviceWorkers: () => workers }, "extension"),
		original,
	);
	let onVersions;
	const version = (runningStatus) => ({
		scriptURL: `${prefix}background/service_worker.js`,
		versionId: "same-version",
		runningStatus,
	});
	const session = {
		on(_name, callback) {
			onVersions = callback;
		},
		async send(command) {
			if (command === "ServiceWorker.enable")
				onVersions({ versions: [version("running")] });
			if (command === "ServiceWorker.stopWorker") {
				onVersions({ versions: [version("stopped")] });
				workers = [worker(`${prefix}background/service_worker.js`), website];
				onVersions({ versions: [version("running")] });
			}
		},
		async detach() {},
	};
	const stopper = await createWorkerStopper(
		{
			newCDPSession: async () => session,
			serviceWorkers: () => workers,
		},
		{},
		"extension",
	);
	const verify = await stopper.stop();
	await verify();
	assert.ok(await original.evaluate(() => {}));
	assert.equal(await website.evaluate(() => {}), undefined);
	await stopper.close();
});
