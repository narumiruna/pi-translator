import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { rspack } from "@rspack/core";
import { afterAll, beforeAll, test } from "vitest";

import { browserSdkRules } from "../scripts/browser-sdk-rules.mjs";

let directory;
let sdk;
let requests;
let responseBody;
let responseStatus;

beforeAll(async () => {
	directory = await mkdtemp(path.join(os.tmpdir(), "vibe-browser-sdk-"));
	const entry = path.join(directory, "entry.mjs");
	await writeFile(
		entry,
		`
export { default as OpenAI } from "openai";
export { default as Anthropic } from "@anthropic-ai/sdk";
export { GoogleGenAI } from "@google/genai";
`,
	);
	const compiler = rspack({
		mode: "production",
		target: "webworker",
		entry,
		devtool: false,
		output: {
			path: directory,
			filename: "sdk.cjs",
			publicPath: "",
			library: { type: "commonjs2" },
		},
		resolve: { modules: [path.resolve("node_modules"), "node_modules"] },
		module: { rules: browserSdkRules },
		plugins: [
			new rspack.DefinePlugin({
				process: "undefined",
				"global.process": "undefined",
			}),
		],
	});
	await new Promise((resolve, reject) =>
		compiler.run((error, stats) => {
			compiler.close((closeError) => {
				if (error || closeError) return reject(error || closeError);
				if (stats.hasErrors())
					return reject(
						new Error(stats.toString({ all: false, errors: true })),
					);
				resolve();
			});
		}),
	);
	const sandbox = {
		module: { exports: {} },
		console,
		URL,
		URLSearchParams,
		Headers,
		Request,
		Response,
		FormData,
		Blob,
		File,
		AbortController,
		AbortSignal,
		TextEncoder,
		TextDecoder,
		ReadableStream,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		crypto,
		fetch: async (url, options) => {
			requests.push({ url: String(url), options });
			return new Response(responseBody, {
				status: responseStatus,
				headers: { "content-type": "text/event-stream" },
			});
		},
	};
	sandbox.self = sandbox;
	runInNewContext(
		await readFile(path.join(directory, "sdk.cjs"), "utf8"),
		sandbox,
	);
	sdk = sandbox.module.exports;
}, 30_000);

afterAll(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
});

function setResponse(events) {
	requests = [];
	responseStatus = 200;
	responseBody = events
		.map((event) => `data: ${JSON.stringify(event)}\n\n`)
		.join("");
}

const clientOptions = {
	apiKey: "mock-secret",
	baseURL: "https://mock.example/v1",
	dangerouslyAllowBrowser: true,
	maxRetries: 0,
};

test("trimmed OpenAI SDK retains streamed Responses requests", async () => {
	setResponse([{ type: "response.output_text.delta", delta: "translated" }]);
	const client = new sdk.OpenAI(clientOptions);
	const { data } = await client.responses
		.create({ model: "mock-model", input: "Alpha", stream: true })
		.withResponse();
	const chunks = [];
	for await (const chunk of data) chunks.push(chunk);
	assert.equal(chunks[0].delta, "translated");
	assert.equal(requests[0].url, "https://mock.example/v1/responses");
	assert.equal(
		new Headers(requests[0].options.headers).get("authorization"),
		"Bearer mock-secret",
	);
	assert.equal(client.images, undefined);
});

test("trimmed OpenAI SDK retains streamed Chat Completions requests", async () => {
	setResponse([{ choices: [{ delta: { content: "translated" } }] }]);
	const client = new sdk.OpenAI(clientOptions);
	const { data } = await client.chat.completions
		.create({
			model: "mock-model",
			messages: [{ role: "user", content: "Alpha" }],
			stream: true,
		})
		.withResponse();
	const chunks = [];
	for await (const chunk of data) chunks.push(chunk);
	assert.equal(chunks[0].choices[0].delta.content, "translated");
	assert.equal(requests[0].url, "https://mock.example/v1/chat/completions");
});

test("trimmed Anthropic SDK retains raw beta message streaming", async () => {
	setResponse([
		{
			type: "content_block_delta",
			delta: { type: "text_delta", text: "translated" },
		},
	]);
	const client = new sdk.Anthropic({
		...clientOptions,
		baseURL: "https://mock.example",
	});
	const response = await client.beta.messages
		.create({
			model: "mock-model",
			messages: [{ role: "user", content: "Alpha" }],
			max_tokens: 50,
			stream: true,
		})
		.asResponse();
	assert.match(await response.text(), /translated/u);
	assert.equal(requests[0].url, "https://mock.example/v1/messages?beta=true");
	assert.equal(
		new Headers(requests[0].options.headers).get("x-api-key"),
		"mock-secret",
	);
	assert.equal(client.beta.agents, undefined);
});

for (const provider of ["OpenAI", "Anthropic"]) {
	test(`trimmed ${provider} SDK preserves authentication errors`, async () => {
		setResponse([]);
		responseStatus = 401;
		responseBody = JSON.stringify({ error: { message: "Invalid API key" } });
		const Client = sdk[provider];
		const client = new Client(clientOptions);
		const request =
			provider === "OpenAI"
				? client.responses
						.create({ model: "mock-model", input: "Alpha", stream: true })
						.withResponse()
				: client.beta.messages
						.create({
							model: "mock-model",
							messages: [{ role: "user", content: "Alpha" }],
							max_tokens: 50,
							stream: true,
						})
						.asResponse();
		await assert.rejects(
			request,
			(error) =>
				error instanceof Client.AuthenticationError && error.status === 401,
		);
	});
}

for (const vertexai of [false, true]) {
	test(`trimmed Google SDK retains ${vertexai ? "Vertex" : "Gemini"} text streaming`, async () => {
		setResponse([
			{
				candidates: [
					{
						content: { role: "model", parts: [{ text: "translated" }] },
						finishReason: "STOP",
					},
				],
			},
		]);
		const client = new sdk.GoogleGenAI({
			apiKey: "mock-secret",
			vertexai,
			httpOptions: { baseUrl: "https://mock.example", apiVersion: "v1" },
		});
		const stream = await client.models.generateContentStream({
			model: "gemini-2.0-flash",
			contents: "Alpha",
			// Match the pi-ai adapters, which do not use automatic continuation.
			config: { automaticContinuation: false },
		});
		const chunks = [];
		for await (const chunk of stream) chunks.push(chunk);
		assert.equal(chunks[0].candidates[0].content.parts[0].text, "translated");
		assert.match(
			requests[0].url,
			/^https:\/\/mock\.example\/v1\/.*:streamGenerateContent\?alt=sse/u,
		);
		assert.equal(client.live, undefined);
		assert.equal(client.models.generateImages, undefined);
	});
}
