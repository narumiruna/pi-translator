import assert from "node:assert/strict";
import { test } from "vitest";

import { createLogger, sanitizeValue } from "../src/shared/logger.js";

test("structured logger redacts secret and source fields", () => {
	const value = sanitizeValue({
		apiKey: "sk-secret",
		authorization: "Bearer private",
		prompt: "translate everything",
		responseBody: "raw response",
		selectedText: "private selection",
		sourceText: "private page text",
		tabId: 7,
	});

	assert.deepEqual(value, {
		apiKey: "[REDACTED]",
		authorization: "[REDACTED]",
		prompt: "[REDACTED]",
		responseBody: "[REDACTED]",
		selectedText: "[REDACTED]",
		sourceText: "[REDACTED]",
		tabId: 7,
	});
});

test("structured logger emits bounded correlation metadata", () => {
	const entries = [];
	const logger = createLogger("content", {
		sink: {
			info(prefix, payload) {
				entries.push({ payload, prefix });
			},
		},
	});

	const payload = logger.info("render-complete", {
		frameId: 2,
		requestId: "selection-1",
		sessionId: "page-1",
		tabId: 9,
		translatedCount: 3,
	});

	assert.deepEqual(entries, [{ prefix: "[Pi Translator]", payload }]);
	assert.deepEqual(payload, {
		component: "content",
		event: "render-complete",
		frameId: 2,
		requestId: "selection-1",
		sessionId: "page-1",
		tabId: 9,
		translatedCount: 3,
	});
});
