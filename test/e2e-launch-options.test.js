import assert from "node:assert/strict";
import { createRequire } from "node:module";
import os from "node:os";
import { afterEach, beforeEach, test, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
	ROOT_DIR,
	createLaunchOptions,
} = require("../e2e/lib/extension-test-helpers.cjs");
const extensionDir = "/extension under test";
const config = { browserChannel: "chromium", headless: false };
const expectedOptions = {
	headless: false,
	channel: "chromium",
	executablePath: undefined,
	ignoreDefaultArgs: ["--disable-extensions"],
	args: [
		`--disable-extensions-except=${extensionDir}`,
		`--load-extension=${extensionDir}`,
	],
};
const waylandOptions = {
	...expectedOptions,
	args: [...expectedOptions.args, "--ozone-platform=wayland"],
};

beforeEach(() => {
	vi.spyOn(os, "platform").mockReturnValue("linux");
	vi.spyOn(os, "release").mockReturnValue("6.8.0-generic");
	vi.stubEnv("WAYLAND_DISPLAY", "");
	vi.stubEnv("WSL_DISTRO_NAME", "");
	vi.stubEnv("WSL_INTEROP", "");
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

for (const [name, environment, release] of [
	["distribution marker", { WSL_DISTRO_NAME: "Ubuntu" }, "6.8.0-generic"],
	["interop marker", { WSL_INTEROP: "/run/WSL/1_interop" }, "6.8.0-generic"],
	["WSL2 kernel", {}, "6.6.87.2-microsoft-standard-WSL2"],
	["mixed-case kernel", {}, "5.15.90.1-Microsoft-standard-WSL2"],
]) {
	test(`headed WSLg appends Wayland for ${name} and preserves all existing options`, () => {
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		for (const [key, value] of Object.entries(environment)) {
			vi.stubEnv(key, value);
		}
		os.release.mockReturnValue(release);
		assert.deepEqual(
			createLaunchOptions(config, undefined, extensionDir),
			waylandOptions,
		);
	});
}

for (const [name, platform, environment, release] of [
	["Linux X11", "linux", {}, "6.8.0-generic"],
	[
		"native Linux Wayland",
		"linux",
		{ WAYLAND_DISPLAY: "wayland-0" },
		"6.8.0-generic",
	],
	[
		"WSL without Wayland",
		"linux",
		{ WSL_DISTRO_NAME: "Ubuntu" },
		"6.6.87.2-microsoft-standard-WSL2",
	],
	[
		"Windows",
		"win32",
		{ WAYLAND_DISPLAY: "wayland-0", WSL_DISTRO_NAME: "Ubuntu" },
		"6.8.0-generic",
	],
	[
		"macOS",
		"darwin",
		{ WAYLAND_DISPLAY: "wayland-0", WSL_DISTRO_NAME: "Ubuntu" },
		"6.8.0-generic",
	],
]) {
	test(`headed ${name} keeps the original launch options`, () => {
		os.platform.mockReturnValue(platform);
		os.release.mockReturnValue(release);
		for (const [key, value] of Object.entries(environment)) {
			vi.stubEnv(key, value);
		}
		assert.deepEqual(
			createLaunchOptions(config, undefined, extensionDir),
			expectedOptions,
		);
	});
}

test("headless WSLg keeps the original launch options", () => {
	vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
	vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
	assert.deepEqual(
		createLaunchOptions({ ...config, headless: true }, undefined, extensionDir),
		{ ...expectedOptions, headless: true },
	);
});

test("forced headless overrides a headed WSLg configuration without adding Wayland", () => {
	vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
	vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
	assert.deepEqual(createLaunchOptions(config, true, extensionDir), {
		...expectedOptions,
		headless: true,
	});
});

test("forced headed overrides a headless WSLg configuration and adds Wayland", () => {
	vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
	vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
	assert.deepEqual(
		createLaunchOptions({ ...config, headless: true }, false, extensionDir),
		waylandOptions,
	);
});

test("an unspecified headless mode preserves Playwright defaults on WSLg", () => {
	vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
	vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
	assert.deepEqual(
		createLaunchOptions(
			{ ...config, headless: undefined },
			undefined,
			extensionDir,
		),
		{ ...expectedOptions, headless: undefined },
	);
});

test("headed WSLg preserves a custom executable and extension path", () => {
	vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
	vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
	const executablePath = "/custom Chromium/chrome";
	assert.deepEqual(
		createLaunchOptions({ ...config, executablePath }, undefined, extensionDir),
		{ ...waylandOptions, channel: undefined, executablePath },
	);
});

test("the default extension directory remains the repository root", () => {
	assert.deepEqual(createLaunchOptions(config), {
		...expectedOptions,
		args: [
			`--disable-extensions-except=${ROOT_DIR}`,
			`--load-extension=${ROOT_DIR}`,
		],
	});
});
