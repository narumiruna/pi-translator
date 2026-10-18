import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "vitest";

for (const stage of ["launch", "close"]) {
	test(`layout regression exits and closes its server after a browser ${stage} error`, () => {
		const script = `
			const { chromium } = require("playwright");
			chromium.launch = async () => {
				if (${JSON.stringify(stage)} === "launch") throw new Error("forced launch failure");
				return {
					newPage: async () => { throw new Error("forced page failure"); },
					close: async () => { throw new Error("forced close failure"); },
				};
			};
			require("./e2e/layout-regression.cjs");
		`;
		const result = spawnSync(process.execPath, ["-e", script], {
			cwd: new URL("..", import.meta.url),
			encoding: "utf8",
			timeout: 3000,
		});
		assert.equal(result.error, undefined, result.stderr);
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, new RegExp(`forced ${stage} failure`));
	});
}
