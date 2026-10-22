import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
	buildMockTranslationText,
	buildMockTranslations,
	createMockApiServer,
	extractJsonObject,
	stringifyMessageContent,
} = require("../e2e/lib/mock-api-server.cjs");

test("mock API extracts source payload JSON from prompt text", () => {
	assert.deepEqual(
		extractJsonObject(
			'Intro text {"targetLanguage":"台灣正體中文","id":"a","text":"Hello"}',
		),
		{ targetLanguage: "台灣正體中文", id: "a", text: "Hello" },
	);
});

test("mock API prefers the last target-language payload JSON in prompt text", () => {
	assert.deepEqual(
		extractJsonObject(
			[
				'Ignore payload {"targetLanguage":"台灣正體中文","id":"old","text":"Old"}',
				'Use payload {"targetLanguage":"台灣正體中文","id":"a","text":"Hello"}',
			].join("\n"),
		),
		{ targetLanguage: "台灣正體中文", id: "a", text: "Hello" },
	);
});

test("mock API falls back to the last item payload when target language is absent", () => {
	assert.deepEqual(
		extractJsonObject(
			[
				'Ignore schema {"items":[],"description":"example"}',
				'Use payload {"items":[{"id":"a","text":"Hello"}]}',
			].join("\n"),
		),
		{ items: [{ id: "a", text: "Hello" }] },
	);
});

test("mock API stringifies Responses-style message content arrays", () => {
	assert.equal(
		stringifyMessageContent([
			{ type: "input_text", text: "Prompt" },
			'{"targetLanguage":"台灣正體中文","id":"a","text":"Hello"}',
			{ type: "image_url", url: "https://example.invalid/image.png" },
		]),
		'Prompt\n{"targetLanguage":"台灣正體中文","id":"a","text":"Hello"}',
	);
});

test("mock API builds translations for single and batch payloads", () => {
	assert.deepEqual(
		buildMockTranslations({
			input: [
				{
					role: "user",
					content: [
						"Prompt prefix",
						JSON.stringify({
							targetLanguage: "台灣正體中文",
							items: [
								{ id: "a", text: "Alpha" },
								{ id: "b", text: "Beta" },
							],
						}),
					].join("\n"),
				},
			],
		}),
		[
			{ id: "a", translatedText: "[mock:Alpha]" },
			{ id: "b", translatedText: "[mock:Beta]" },
		],
	);
});

test("mock API preserves protected placeholders beyond its text preview", () => {
	const [translation] = buildMockTranslations({
		input: [
			{
				role: "user",
				content: JSON.stringify({
					targetLanguage: "台灣正體中文",
					id: "a",
					text: `${"Long source text ".repeat(5)}__OT_TOKEN_7__`,
				}),
			},
		],
	});

	assert.match(translation.translatedText, /__OT_TOKEN_7__/);
});

test("mock API never splits a protected placeholder at the preview boundary", () => {
	for (const kind of ["TOKEN", "MATH"]) {
		for (const start of [35, 40, 47, 48]) {
			const placeholder = `__OT_${kind}_1__`;
			const translation = buildMockTranslationText(
				`${"a".repeat(start)}${placeholder} trailing prose __OT_TOKEN_2__`,
			);
			assert.equal(translation.split(placeholder).length - 1, 1);
			assert.equal(translation.split("__OT_TOKEN_2__").length - 1, 1);
			assert.doesNotMatch(
				translation.replace(/__OT_(?:TOKEN|MATH)_\d+__/g, ""),
				/__OT_/,
			);
		}
	}
});

test("mock API server exposes models and responses endpoints", async () => {
	const server = await createMockApiServer();

	try {
		const modelsResponse = await fetch(`${server.baseUrl}/models`);
		assert.equal(modelsResponse.status, 200);
		assert.deepEqual(await modelsResponse.json(), {
			data: [{ id: "mock-model" }],
		});

		const responsesResponse = await fetch(`${server.baseUrl}/responses`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				input: [
					{
						role: "user",
						content:
							'{"targetLanguage":"台灣正體中文","id":"a","text":"Alpha"}',
					},
				],
			}),
		});
		assert.equal(responsesResponse.status, 200);
		assert.deepEqual(await responsesResponse.json(), {
			output_parsed: {
				translations: [{ id: "a", translatedText: "[mock:Alpha]" }],
			},
			output_text: JSON.stringify({
				translations: [{ id: "a", translatedText: "[mock:Alpha]" }],
			}),
		});
		assert.deepEqual(server.getResponseItemIds(), ["a"]);
		assert.equal(server.getMaxActiveResponseCount(), 1);
	} finally {
		await server.close();
	}
});

test("mock API server can fail the next response deterministically", async () => {
	const server = await createMockApiServer();
	const request = () =>
		fetch(`${server.baseUrl}/responses`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				input: [
					{
						role: "user",
						content:
							'{"targetLanguage":"台灣正體中文","id":"a","text":"Alpha"}',
					},
				],
			}),
		});

	try {
		server.failNextResponses(2);
		assert.equal((await request()).status, 500);
		assert.equal((await request()).status, 500);
		assert.equal((await request()).status, 200);
	} finally {
		await server.close();
	}
});

test("mock API stalls after headers until the client aborts the real connection", async () => {
	const server = await createMockApiServer();
	const controller = new AbortController();
	try {
		server.stallNextResponses();
		const response = await fetch(`${server.baseUrl}/responses`, {
			method: "POST",
			body: JSON.stringify({ stream: true }),
			signal: controller.signal,
		});
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type"), /text\/event-stream/);
		assert.equal(server.getActiveResponseCount(), 1);
		const body = response.text();
		controller.abort();
		await assert.rejects(body, /abort/i);
		await vi.waitFor(() => assert.equal(server.getAbortedResponseCount(), 1));
		assert.equal(server.getActiveResponseCount(), 0);
		assert.equal(server.getRequests()[0].aborted, true);
		const next = await fetch(`${server.baseUrl}/responses`, { method: "POST" });
		assert.equal(next.status, 200);
		await next.text();
	} finally {
		controller.abort();
		await server.close();
	}
});

test("mock API reserves one-shot delays and failures in request order", async () => {
	const server = await createMockApiServer();
	try {
		server.delayNextResponses(100);
		server.failNextResponses();
		const first = fetch(`${server.baseUrl}/responses`, { method: "POST" });
		await vi.waitFor(() => assert.equal(server.getResponseRequestCount(), 1));
		const second = await fetch(`${server.baseUrl}/responses`, {
			method: "POST",
		});
		assert.equal(second.status, 200);
		await second.text();
		assert.equal((await first).status, 500);
		assert.equal(server.getMaxActiveResponseCount(), 2);
	} finally {
		await server.close();
	}
});

test("mock API closes stalled connections without waiting for a client abort", async () => {
	const server = await createMockApiServer();
	server.stallNextResponses();
	const response = await fetch(`${server.baseUrl}/responses`, {
		method: "POST",
	});
	const body = response.text();
	const rejected = assert.rejects(body);
	await server.close();
	await rejected;
});

test("mock API server can fail matching response requests", async () => {
	const server = await createMockApiServer({ failOnTextIncludes: "Fail me" });

	try {
		const response = await fetch(`${server.baseUrl}/responses`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				input: [
					{
						role: "user",
						content:
							'{"targetLanguage":"台灣正體中文","id":"a","text":"Fail me"}',
					},
				],
			}),
		});

		assert.equal(response.status, 500);
		assert.match((await response.json()).error.message, /Mock translation/);

		server.setFailOnTextIncludes("");
		const recovered = await fetch(`${server.baseUrl}/responses`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				input: [
					{
						role: "user",
						content:
							'{"targetLanguage":"台灣正體中文","id":"a","text":"Fail me"}',
					},
				],
			}),
		});

		assert.equal(recovered.status, 200);
	} finally {
		await server.close();
	}
});
