const http = require("node:http");

function readRequestBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];

		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}

function extractJsonObject(text) {
	const source = String(text || "");
	const starts = [];

	for (let index = 0; index < source.length; index += 1) {
		if (source[index] === "{") {
			starts.push(index);
		}
	}

	const targetPayloads = [];
	const itemPayloads = [];
	const fallbackPayloads = [];

	for (const start of starts) {
		for (let end = source.length; end > start; end -= 1) {
			try {
				const parsed = JSON.parse(source.slice(start, end));

				if (parsed?.targetLanguage) {
					targetPayloads.push(parsed);
				}

				if (parsed?.items) {
					itemPayloads.push(parsed);
				}

				if (parsed?.text) {
					fallbackPayloads.push(parsed);
				}
			} catch (_error) {
				// Keep trimming until any prompt suffix is removed.
			}
		}
	}

	return (
		targetPayloads.at(-1) ||
		itemPayloads.at(-1) ||
		fallbackPayloads.at(-1) ||
		null
	);
}

function stringifyMessageContent(content) {
	if (Array.isArray(content)) {
		return content
			.map((item) => {
				if (typeof item === "string") {
					return item;
				}

				if (typeof item?.text === "string") {
					return item.text;
				}

				return "";
			})
			.filter(Boolean)
			.join("\n");
	}

	return String(content || "");
}

function buildMockTranslationText(text) {
	const source = String(text || "");
	const placeholders = Array.from(
		source.matchAll(/__OT_(?:TOKEN|MATH)_\d+__/g),
	);
	let previewEnd = 48;
	for (const match of placeholders) {
		if (match.index < previewEnd) {
			previewEnd = Math.max(previewEnd, match.index + match[0].length);
		}
	}
	const preview = source.slice(0, previewEnd);
	const trailingPlaceholders = Array.from(
		new Set(placeholders.map((match) => match[0])),
	).filter((placeholder) => !preview.includes(placeholder));
	const suffix =
		trailingPlaceholders.length > 0 ? ` ${trailingPlaceholders.join(" ")}` : "";

	return `[mock:${preview}${suffix}]`;
}

function buildMockTranslations(requestPayload) {
	const input = Array.isArray(requestPayload?.input)
		? requestPayload.input
		: [];
	const userMessage = input.find((item) => item?.role === "user");
	const sourcePayload = extractJsonObject(
		stringifyMessageContent(userMessage?.content),
	);
	const sourceItems = Array.isArray(sourcePayload?.items)
		? sourcePayload.items
		: sourcePayload?.id
			? [sourcePayload]
			: [{ id: "sample", text: "Hello world." }];

	return sourceItems.map((item) => ({
		id: String(item.id),
		translatedText: buildMockTranslationText(item.text),
	}));
}

async function createMockApiServer(options = {}) {
	const state = {
		activeResponseCount: 0,
		abortedResponseCount: 0,
		stallNextResponseCount: 0,
		nextDelays: [],
		requests: [],
		failNextResponseCount: 0,
		failOnTextIncludes: options.failOnTextIncludes || "",
		maxActiveResponseCount: 0,
		responseDelayMs: Number(options.responseDelayMs) || 0,
		responseItemIds: [],
		responseRequestCount: 0,
	};
	const sockets = new Set();
	const server = http.createServer(async (request, response) => {
		const requestUrl = new URL(request.url || "/", "http://127.0.0.1");

		if (request.method === "GET" && requestUrl.pathname === "/v1/models") {
			response.writeHead(200, {
				"Content-Type": "application/json; charset=utf-8",
			});
			response.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
			return;
		}

		if (request.method === "POST" && requestUrl.pathname === "/v1/responses") {
			state.activeResponseCount += 1;
			state.maxActiveResponseCount = Math.max(
				state.maxActiveResponseCount,
				state.activeResponseCount,
			);
			state.responseRequestCount += 1;
			const record = {
				startedAt: Date.now(),
				finishedAt: null,
				aborted: false,
				stalled: state.stallNextResponseCount > 0,
				itemIds: [],
			};
			state.requests.push(record);
			if (record.stalled) state.stallNextResponseCount -= 1;
			const failNextResponse = state.failNextResponseCount > 0;
			if (failNextResponse) state.failNextResponseCount -= 1;
			const delayMs = state.nextDelays.shift() ?? state.responseDelayMs;
			let delayTimer;
			let releaseDelay;
			const settle = () => {
				if (record.finishedAt !== null) return;
				record.finishedAt = Date.now();
				record.aborted = !response.writableFinished;
				if (record.aborted) state.abortedResponseCount += 1;
				state.activeResponseCount -= 1;
				clearTimeout(delayTimer);
				releaseDelay?.();
			};
			response.once("finish", settle);
			response.once("close", settle);

			try {
				let requestPayload = {};

				try {
					requestPayload = JSON.parse(await readRequestBody(request));
				} catch (_error) {
					requestPayload = {};
				}

				const translations = buildMockTranslations(requestPayload);

				record.itemIds = translations.map((translation) => translation.id);
				state.responseItemIds.push(...record.itemIds);

				if (record.stalled) {
					// Send real SSE headers, but never send a body or finish the response.
					response.writeHead(200, {
						"Content-Type": "text/event-stream; charset=utf-8",
						"Cache-Control": "no-cache",
					});
					response.flushHeaders();
					return;
				}
				if (delayMs > 0) {
					await new Promise((resolve) => {
						releaseDelay = resolve;
						delayTimer = setTimeout(resolve, delayMs);
					});
				}
				if (response.destroyed) return;
				if (
					failNextResponse ||
					(state.failOnTextIncludes &&
						JSON.stringify(requestPayload).includes(state.failOnTextIncludes))
				) {
					response.writeHead(500, {
						"Content-Type": "application/json; charset=utf-8",
					});
					response.end(
						JSON.stringify({
							error: { message: "Mock translation failure." },
						}),
					);
					return;
				}

				const outputText = JSON.stringify({ translations });
				if (requestPayload.stream) {
					const responseId = `resp_mock_${state.responseRequestCount}`;
					const item = {
						id: `msg_mock_${state.responseRequestCount}`,
						type: "message",
						role: "assistant",
						status: "completed",
						content: [
							{ type: "output_text", text: outputText, annotations: [] },
						],
					};
					const events = [
						{
							type: "response.created",
							response: { id: responseId, status: "in_progress", output: [] },
						},
						{ type: "response.output_item.added", output_index: 0, item },
						{
							type: "response.output_text.delta",
							output_index: 0,
							content_index: 0,
							delta: outputText,
						},
						{ type: "response.output_item.done", output_index: 0, item },
						{
							type: "response.completed",
							response: {
								id: responseId,
								status: "completed",
								output: [item],
								usage: {
									input_tokens: 1,
									output_tokens: 1,
									total_tokens: 2,
									input_tokens_details: { cached_tokens: 0 },
								},
							},
						},
					];
					response.writeHead(200, {
						"Content-Type": "text/event-stream; charset=utf-8",
						"Cache-Control": "no-cache",
					});
					response.end(
						events
							.map((event) => `data: ${JSON.stringify(event)}\n\n`)
							.join(""),
					);
					return;
				}

				response.writeHead(200, {
					"Content-Type": "application/json; charset=utf-8",
				});
				response.end(
					JSON.stringify({
						output_parsed: { translations },
						output_text: outputText,
					}),
				);
				return;
			} catch (error) {
				response.destroy(error);
			}
		}

		response.writeHead(404, {
			"Content-Type": "application/json; charset=utf-8",
		});
		response.end(JSON.stringify({ error: { message: "Not Found" } }));
	});

	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});

	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;

	return {
		origin: `http://127.0.0.1:${port}`,
		baseUrl: `http://127.0.0.1:${port}/v1`,
		getActiveResponseCount() {
			return state.activeResponseCount;
		},
		getAbortedResponseCount() {
			return state.abortedResponseCount;
		},
		getRequests() {
			return state.requests.map((record) => ({
				...record,
				itemIds: [...record.itemIds],
			}));
		},
		stallNextResponses(count = 1) {
			state.stallNextResponseCount = Math.max(0, Number(count) || 0);
		},
		delayNextResponses(delayMs, count = 1) {
			state.nextDelays.push(
				...Array.from({ length: Math.max(0, Number(count) || 0) }, () =>
					Math.max(0, Number(delayMs) || 0),
				),
			);
		},
		getMaxActiveResponseCount() {
			return state.maxActiveResponseCount;
		},
		getResponseItemIds() {
			return [...state.responseItemIds];
		},
		getResponseRequestCount() {
			return state.responseRequestCount;
		},
		failNextResponses(count = 1) {
			state.failNextResponseCount = Math.max(0, Number(count) || 0);
		},
		setFailOnTextIncludes(value) {
			state.failOnTextIncludes = String(value || "");
		},
		setResponseDelayMs(value) {
			state.responseDelayMs = Math.max(0, Number(value) || 0);
		},
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}

					resolve();
				});
				for (const socket of sockets) socket.destroy();
			}),
	};
}

module.exports = {
	buildMockTranslationText,
	buildMockTranslations,
	createMockApiServer,
	extractJsonObject,
	stringifyMessageContent,
};
