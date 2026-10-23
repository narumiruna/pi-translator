import { rspack } from "@rspack/core";

import { browserSdkRules } from "./scripts/browser-sdk-rules.mjs";

/** @type {import("extension").FileConfig} */
const config = {
	browser: {
		chrome: {
			persistProfile: true,
			profile: "./dist/extension-profile-chrome",
		},
		firefox: {
			profile: "./dist/extension-profile-firefox",
		},
	},
	commands: {
		dev: {
			logColor: true,
			logContexts: ["background", "content", "options", "page"],
			logLevel: "info",
			logTimestamps: true,
		},
	},
	config(rspackConfig) {
		rspackConfig.module ??= {};
		rspackConfig.module.rules ??= [];
		rspackConfig.module.rules.push(...browserSdkRules);
		rspackConfig.plugins ??= [];
		rspackConfig.plugins.push(
			new rspack.DefinePlugin({
				process: "undefined",
				"global.process": "undefined",
			}),
			// Extension.js defaults service-worker chunks to importScripts(), which is
			// unavailable in an MV3 module worker. Text adapters are statically bundled;
			// this loader remains only for unreachable optional SDK branches.
			new rspack.javascript.EnableChunkLoadingPlugin("import"),
			{
				apply(compiler) {
					compiler.hooks.entryOption.tap(
						"PiTranslatorModuleServiceWorkerChunks",
						(_context, entries) => {
							const serviceWorker = entries?.["background/service_worker"];
							if (serviceWorker) {
								serviceWorker.chunkLoading = "import";
							}
						},
					);
				},
			},
		);
		return rspackConfig;
	},
};

export default config;
