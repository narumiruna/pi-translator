import assert from "node:assert/strict";
import { test } from "vitest";
import {
	buildResponsesRequest,
	buildTranslationInput,
	chunkTranslationItems,
	clearTranslationCache,
	consumeProgressiveTranslations,
	createProgressiveMergeState,
	createRecursiveChunkPlan,
	createTranslationApi,
	extractOutputText,
	getIncompleteSegmentIds,
	maskProtectedFragments,
	mergeRecursiveTranslations,
	parseTranslationResponse,
	requestTranslations,
	requestTranslationsBatched,
	requestTranslationsBatchedProgressive,
	splitTextRecursively,
	unmaskProtectedFragments,
	validateProtectedFragments,
} from "../src/translation/api.js";
import { validateTranslationCoverage } from "../src/translation/responses.js";

function buildSettings(overrides) {
	return {
		apiKey: "x",
		baseUrl: "https://example.com/v1",
		model: "demo",
		systemPromptTemplate:
			"System template for {{targetLanguage}} ({{itemCount}} items).",
		userPromptTemplate: "User template for {{itemKind}}.\n\n{{sourcePayload}}",
		targetLanguage: "台灣正體中文",
		...overrides,
	};
}

test("chunkTranslationItems splits by character limit", () => {
	const chunks = chunkTranslationItems(
		[
			{ id: "a", text: "1234" },
			{ id: "b", text: "1234" },
			{ id: "c", text: "1234" },
		],
		8,
	);

	assert.equal(chunks.length, 2);
	assert.deepEqual(
		chunks[0].map((item) => item.id),
		["a", "b"],
	);
	assert.deepEqual(
		chunks[1].map((item) => item.id),
		["c"],
	);
});

test("splitTextRecursively breaks a long text into bounded parts", () => {
	const parts = splitTextRecursively(
		"alpha beta gamma delta epsilon zeta eta theta iota kappa lambda",
		12,
	);

	assert.ok(parts.length > 1);
	assert.ok(parts.every((part) => part.text.length <= 12));
});

test("createRecursiveChunkPlan creates one request per non-oversized item", () => {
	const plan = createRecursiveChunkPlan(
		[
			{ id: "a", kind: "paragraph", text: "Alpha paragraph." },
			{ id: "b", kind: "paragraph", text: "Beta paragraph." },
			{ id: "c", kind: "heading", text: "Gamma heading" },
		],
		200,
	);

	assert.equal(plan.chunks.length, 3);
	assert.deepEqual(
		plan.chunks.map((chunk) => chunk.map((item) => item.id)),
		[["a"], ["b"], ["c"]],
	);
});

test("progressive chunk merging preserves timed subtitle metadata", () => {
	const plan = createRecursiveChunkPlan([
		{
			id: "youtube-cue-1000-0",
			cueId: "youtube-cue-1000-0",
			cueStartMs: 1000,
			durationMs: 3000,
			kind: "subtitle",
			text: "Build reliable tools",
		},
	]);
	const state = createProgressiveMergeState(plan);
	const [completed] = consumeProgressiveTranslations(plan, state, [
		{ id: "youtube-cue-1000-0", translation: "建立可靠工具" },
	]);

	assert.equal(plan.expandedItems[0].cueStartMs, 1000);
	assert.deepEqual(completed, {
		id: "youtube-cue-1000-0",
		cueId: "youtube-cue-1000-0",
		cueStartMs: 1000,
		durationMs: 3000,
		kind: "subtitle",
		protectedFragments: [],
		sourceText: "Build reliable tools",
		translation: "建立可靠工具",
	});
});

test("createRecursiveChunkPlan splits oversized items and mergeRecursiveTranslations restores them", () => {
	const plan = createRecursiveChunkPlan(
		[
			{
				id: "long",
				kind: "paragraph",
				text: "First sentence. Second sentence. Third sentence. Fourth sentence.",
			},
		],
		24,
	);

	assert.ok(plan.expandedItems.length > 1);
	assert.ok(plan.expandedItems.every((item) => item.text.length <= 24));
	assert.ok(plan.chunks.every((chunk) => chunk.length === 1));

	const merged = mergeRecursiveTranslations(
		plan,
		plan.expandedItems.map((item) => ({
			id: item.id,
			translation: `[${item.text}]`,
		})),
	);

	assert.equal(merged.length, 1);
	assert.equal(merged[0].id, "long");
	assert.match(merged[0].translation, /^\[First sentence\./);
	assert.match(merged[0].translation, /Fourth sentence\.\]$/);
});

test("createRecursiveChunkPlan preserves pre-extracted math placeholders for DOM recomposition", () => {
	const plan = createRecursiveChunkPlan(
		[
			{
				id: "math",
				kind: "paragraph",
				text: "The goal is __OT_MATH_1__ and the posterior is __OT_MATH_2__.",
				protectedFragments: [
					{
						placeholder: "__OT_MATH_1__",
						value: "$p^*(x)$",
						text: "p*(x)",
						html: '<span class="katex">p*(x)</span>',
						preservePlaceholder: true,
					},
					{
						placeholder: "__OT_MATH_2__",
						value: "\\(q_\\theta(x)\\)",
						text: "q_theta(x)",
						html: '<span class="katex">q_theta(x)</span>',
						preservePlaceholder: true,
					},
				],
			},
		],
		24,
	);

	const merged = mergeRecursiveTranslations(
		plan,
		plan.expandedItems.map((item) => ({
			id: item.id,
			translation: item.text,
		})),
	);

	assert.equal(merged.length, 1);
	assert.equal(
		merged[0].translation,
		"The goal is __OT_MATH_1__ and the posterior is __OT_MATH_2__.",
	);
	assert.deepEqual(
		merged[0].protectedFragments,
		plan.items[0].protectedFragments,
	);
});

test("unmaskProtectedFragments keeps preserved placeholders in translated text", () => {
	assert.equal(
		unmaskProtectedFragments("Before __OT_MATH_1__ after", [
			{
				placeholder: "__OT_MATH_1__",
				value: "$x$",
				preservePlaceholder: true,
			},
		]),
		"Before __OT_MATH_1__ after",
	);
});

test("maskProtectedFragments preserves code paths urls and tech terms", () => {
	const masked = maskProtectedFragments(
		"Run `npm run dev` in src/bot/ and open https://example.com/docs for the GitHub API guide.",
	);

	assert.notEqual(masked.maskedText.includes("`npm run dev`"), true);
	assert.ok(masked.tokens.length >= 4);

	const restored = unmaskProtectedFragments(masked.maskedText, masked.tokens);

	assert.equal(
		restored,
		"Run `npm run dev` in src/bot/ and open https://example.com/docs for the GitHub API guide.",
	);
});

test("maskProtectedFragments preserves latex math expressions", () => {
	const masked = maskProtectedFragments(
		"The goal is $p^*(x)$ while \\(q_\\theta(x)\\) approximates the posterior.",
	);

	assert.ok(masked.tokens.some((token) => token.value === "$p^*(x)$"));
	assert.ok(
		masked.tokens.some((token) => token.value === "\\(q_\\theta(x)\\)"),
	);
	assert.equal(
		unmaskProtectedFragments(masked.maskedText, masked.tokens),
		"The goal is $p^*(x)$ while \\(q_\\theta(x)\\) approximates the posterior.",
	);
});

test("buildTranslationInput renders prompt templates with source payload", () => {
	const input = buildTranslationInput({
		...buildSettings(),
		items: [
			{
				id: "1",
				kind: "heading",
				text: "Hello",
				isUI: false,
				isMetadata: false,
				containsMath: false,
			},
		],
	});

	assert.equal(input.length, 2);
	assert.equal(input[0].role, "system");
	assert.match(input[0].content, /台灣正體中文/);
	assert.match(input[0].content, /1 items/);
	assert.equal(input[1].role, "user");
	assert.match(input[1].content, /User template for heading/);
	assert.match(input[1].content, /"targetLanguage":"台灣正體中文"/);
	assert.match(input[1].content, /"id":"1"/);
	assert.match(input[1].content, /"kind":"heading"/);
	assert.match(input[1].content, /"isUI":false/);
	assert.match(input[1].content, /"isMetadata":false/);
	assert.match(input[1].content, /"containsMath":false/);
	assert.match(input[1].content, /"text":"Hello"/);
	assert.doesNotMatch(input[1].content, /"items":\[/);
});

test("buildResponsesRequest uses responses api shape", () => {
	const payload = buildResponsesRequest(buildSettings(), [
		{ id: "1", kind: "heading", text: "Hello" },
	]);

	assert.equal(payload.model, "demo");
	assert.equal(payload.input.length, 2);
	assert.equal(payload.text.format.type, "json_schema");
	assert.equal(payload.text.format.name, "translation_result");
	assert.equal(payload.text.format.strict, true);
	assert.deepEqual(payload.text.format.schema.required, ["translations"]);
	assert.deepEqual(
		payload.text.format.schema.properties.translations.items.required,
		["id", "translatedText"],
	);
});

test("parseTranslationResponse reads output_parsed translatedText", () => {
	const parsed = parseTranslationResponse({
		output_parsed: {
			translations: [{ id: "1", translatedText: "你好" }],
		},
	});

	assert.deepEqual(parsed, [{ id: "1", translation: "你好" }]);
});

test("parseTranslationResponse still accepts legacy translation field", () => {
	const parsed = parseTranslationResponse({
		output_parsed: {
			translations: [{ id: "1", translation: "你好" }],
		},
	});

	assert.deepEqual(parsed, [{ id: "1", translation: "你好" }]);
});

test("extractOutputText aggregates output text content", () => {
	const text = extractOutputText({
		output: [
			{
				type: "message",
				content: [
					{ type: "output_text", text: '{"translations":' },
					{ type: "output_text", text: '[{"id":"1","translation":"你好"}]}' },
				],
			},
		],
	});

	assert.equal(text, '{"translations":\n[{"id":"1","translation":"你好"}]}');
});

test("requestTranslations retries once when first response is invalid JSON", async () => {
	let calls = 0;
	const fakeFetch = async () => {
		calls += 1;

		if (calls === 1) {
			return {
				ok: true,
				text: async () =>
					JSON.stringify({
						output: [
							{
								type: "message",
								content: [{ type: "output_text", text: "not-json" }],
							},
						],
					}),
			};
		}

		return {
			ok: true,
			text: async () =>
				JSON.stringify({
					output_parsed: {
						translations: [{ id: "1", translation: "你好" }],
					},
				}),
		};
	};

	const result = await requestTranslations({
		settings: buildSettings(),
		items: [{ id: "1", text: "Hello" }],
		fetchImpl: fakeFetch,
	});

	assert.equal(calls, 2);
	assert.deepEqual(result, [{ id: "1", translation: "你好" }]);
});

test("requestTranslations retries once when a successful response is missing an id", async () => {
	clearTranslationCache();
	let calls = 0;
	const fakeFetch = async () => {
		calls += 1;
		return {
			ok: true,
			text: async () =>
				JSON.stringify({
					output_parsed: {
						translations:
							calls === 1
								? [{ id: "a", translation: "甲" }]
								: [
										{ id: "a", translation: "甲" },
										{ id: "b", translation: "乙" },
									],
					},
				}),
		};
	};

	const result = await requestTranslations({
		settings: buildSettings({ model: "missing-id-retry" }),
		items: [
			{ id: "a", text: "Alpha" },
			{ id: "b", text: "Beta" },
		],
		fetchImpl: fakeFetch,
	});

	assert.equal(calls, 2);
	assert.deepEqual(result, [
		{ id: "a", translation: "甲" },
		{ id: "b", translation: "乙" },
	]);
});

test("requestTranslations retries once when a protected placeholder is missing", async () => {
	clearTranslationCache();
	let calls = 0;
	const fakeFetch = async () => {
		calls += 1;
		return {
			ok: true,
			text: async () =>
				JSON.stringify({
					output_parsed: {
						translations: [
							{
								id: "protected",
								translation: calls === 1 ? "執行命令" : "執行 __OT_TOKEN_1__",
							},
						],
					},
				}),
		};
	};

	const result = await requestTranslations({
		settings: buildSettings({ model: "placeholder-retry" }),
		items: [
			{
				id: "protected",
				text: "Run __OT_TOKEN_1__",
				protectedFragments: [
					{ placeholder: "__OT_TOKEN_1__", value: "`npm test`" },
				],
			},
		],
		fetchImpl: fakeFetch,
	});

	assert.equal(calls, 2);
	assert.deepEqual(result, [
		{ id: "protected", translation: "執行 __OT_TOKEN_1__" },
	]);
});

test("salary ranges and nested code survive request validation and both merge paths", async () => {
	clearTranslationCache();
	const text =
		"Pay $50–$150/hr and $200/day. Use `$x$ and API` with __OT_MATH_1__.";
	const plan = createRecursiveChunkPlan(
		[
			{
				id: "salary",
				text,
				protectedFragments: [
					{
						placeholder: "__OT_MATH_1__",
						value: "$y$",
						preservePlaceholder: true,
					},
				],
			},
		],
		48,
	);
	const state = createProgressiveMergeState(plan);
	const completed = [];
	const result = await requestTranslationsBatchedProgressive({
		settings: buildSettings({ model: "salary-round-trip" }),
		chunks: plan.chunks,
		async fetchImpl(_url, options) {
			const body = JSON.parse(options.body);
			const item = JSON.parse(body.input[1].content.split("\n\n").at(-1));
			return {
				ok: true,
				text: async () =>
					JSON.stringify({
						output_parsed: {
							translations: [
								{
									id: item.id,
									translation: item.text
										.replace("Pay", "支付")
										.replace("Use", "使用"),
								},
							],
						},
					}),
			};
		},
		onChunkResolved({ translations }) {
			completed.push(
				...consumeProgressiveTranslations(plan, state, translations),
			);
		},
	});
	assert.deepEqual(result.failures, []);
	assert.deepEqual(
		completed,
		mergeRecursiveTranslations(plan, result.successes),
	);
	assert.equal(
		completed[0].translation,
		text.replace("Pay", "支付").replace("Use", "使用"),
	);
	assert.doesNotMatch(completed[0].translation, /__OT_TOKEN_/);
	assert.equal(completed[0].protectedFragments.length, 1);
});

test("literal code placeholders and split prefixes survive both merge paths", () => {
	for (const text of [
		"`__OT_MATH_42__` means a placeholder; `hello` is code.",
		"__OT_`x`TOKEN_",
	]) {
		const plan = createRecursiveChunkPlan([{ id: "code", text }], 48);
		const translations = plan.expandedItems.map((item) => ({
			id: item.id,
			translation: item.text.replace("means", "表示").replace("is", "是"),
		}));
		validateProtectedFragments(plan.expandedItems, translations);
		const merged = mergeRecursiveTranslations(plan, translations);
		const state = createProgressiveMergeState(plan);
		const completed = translations.flatMap((translation) =>
			consumeProgressiveTranslations(plan, state, [translation]),
		);
		assert.deepEqual(completed, merged);
		assert.equal(
			merged[0].translation,
			text.replace("means", "表示").replace("is", "是"),
		);
	}
});

test("corrupted tokens fail both response paths without emitting or caching translations", async () => {
	for (const useProviderRuntime of [false, true]) {
		for (const corrupted of [
			"__OT_TOKEN_99__",
			"__OT_TOKEN_X__",
			"__OT_TOKEN_1_",
			"__OT_TOKEN_1__",
			"__OT_MATH_99__",
		]) {
			clearTranslationCache();
			let calls = 0;
			let fail = true;
			const plan = createRecursiveChunkPlan([
				{ id: "protected", text: "Use API" },
			]);
			const makeResponse = () => {
				calls += 1;
				return {
					translations: [
						{
							id: "protected",
							translation: `使用 __OT_TOKEN_1__${fail ? ` ${corrupted}` : ""}`,
						},
					],
				};
			};
			const api = useProviderRuntime
				? createTranslationApi({
						getModelCacheIdentity: async () => "placeholder-validation",
						complete: async () => ({ text: JSON.stringify(makeResponse()) }),
					})
				: { requestTranslationsBatchedProgressive };
			const emitted = [];
			const options = {
				settings: buildSettings({ model: "corrupted-tokens" }),
				chunks: plan.chunks,
				fetchImpl: async () => ({
					ok: true,
					text: async () => JSON.stringify({ output_parsed: makeResponse() }),
				}),
				onChunkResolved: ({ translations }) => emitted.push(...translations),
			};
			const failed = await api.requestTranslationsBatchedProgressive(options);
			assert.equal(calls, 2);
			assert.deepEqual(failed.successes, []);
			assert.deepEqual(emitted, []);
			assert.equal(failed.failures.length, 1);
			assert.match(failed.failures[0].error.message, /Protected placeholder/);
			fail = false;
			const retried = await api.requestTranslationsBatchedProgressive(options);
			assert.equal(calls, 3);
			assert.deepEqual(retried.failures, []);
			assert.equal(
				mergeRecursiveTranslations(plan, retried.successes)[0].translation,
				"使用 API",
			);
		}
	}
});

test("requestTranslations does not retry HTTP failures", async () => {
	clearTranslationCache();
	let calls = 0;

	await assert.rejects(
		requestTranslations({
			settings: buildSettings({ model: "http-no-retry" }),
			items: [{ id: "a", text: "Alpha" }],
			async fetchImpl() {
				calls += 1;
				return {
					ok: false,
					status: 429,
					text: async () =>
						JSON.stringify({ error: { message: "Rate limited." } }),
				};
			},
		}),
		/Rate limited\./,
	);
	assert.equal(calls, 1);
});

test("requestTranslations does not retry network failures", async () => {
	clearTranslationCache();
	let calls = 0;

	await assert.rejects(
		requestTranslations({
			settings: buildSettings({ model: "network-no-retry" }),
			items: [{ id: "a", text: "Alpha" }],
			async fetchImpl() {
				calls += 1;
				throw new TypeError("Network unavailable.");
			},
		}),
		/Network unavailable\./,
	);
	assert.equal(calls, 1);
});

test("requestTranslations reuses cached translations for identical text and settings", async () => {
	clearTranslationCache();

	let calls = 0;
	const fakeFetch = async () => {
		calls += 1;

		return {
			ok: true,
			text: async () =>
				JSON.stringify({
					output_parsed: {
						translations: [{ id: "1", translation: "你好" }],
					},
				}),
		};
	};
	const settings = buildSettings({ model: "demo-cache" });

	const first = await requestTranslations({
		settings,
		items: [{ id: "1", kind: "paragraph", text: "Hello" }],
		fetchImpl: fakeFetch,
	});
	const second = await requestTranslations({
		settings,
		items: [{ id: "2", kind: "paragraph", text: "Hello" }],
		fetchImpl: fakeFetch,
	});

	assert.equal(calls, 1);
	assert.deepEqual(first, [{ id: "1", translation: "你好" }]);
	assert.deepEqual(second, [{ id: "2", translation: "你好" }]);
});

test("requestTranslations bypasses cached results without replacing them", async () => {
	clearTranslationCache();
	let calls = 0;
	const settings = buildSettings({ model: "cache-bypass" });
	const completeImpl = async (_settings, items) => {
		calls += 1;
		return items.map((item) => ({
			id: item.id,
			translation: `translation-${calls}`,
		}));
	};

	await requestTranslations({
		settings,
		items: [{ id: "first", kind: "paragraph", text: "Hello" }],
		completeImpl,
	});
	const bypassed = await requestTranslations({
		settings,
		items: [{ id: "second", kind: "paragraph", text: "Hello" }],
		completeImpl,
		bypassCache: true,
	});
	const cached = await requestTranslations({
		settings,
		items: [{ id: "third", kind: "paragraph", text: "Hello" }],
		completeImpl,
	});

	assert.equal(calls, 2);
	assert.deepEqual(bypassed, [{ id: "second", translation: "translation-2" }]);
	assert.deepEqual(cached, [{ id: "third", translation: "translation-1" }]);
});

test("validateProtectedFragments rejects missing placeholders", () => {
	assert.throws(() => {
		validateProtectedFragments(
			[
				{
					id: "1",
					text: "__OT_TOKEN_1__ hello",
					protectedFragments: [
						{ placeholder: "__OT_TOKEN_1__", value: "`npm run dev`" },
					],
				},
			],
			[{ id: "1", translation: "你好" }],
		);
	}, /Protected placeholder/);
});

test("validateTranslationCoverage rejects missing duplicate and unknown ids", () => {
	const items = [
		{ id: "a", text: "Alpha" },
		{ id: "b", text: "Beta" },
	];

	assert.throws(
		() => validateTranslationCoverage(items, [{ id: "a", translation: "甲" }]),
		/missing id/i,
	);
	assert.throws(
		() =>
			validateTranslationCoverage(items, [
				{ id: "a", translation: "甲" },
				{ id: "a", translation: "乙" },
			]),
		/duplicate id/i,
	);
	assert.throws(
		() =>
			validateTranslationCoverage(items, [
				{ id: "a", translation: "甲" },
				{ id: "c", translation: "丙" },
			]),
		/unknown id/i,
	);
});

test("requestTranslations retries incomplete coverage before caching", async () => {
	clearTranslationCache();

	let calls = 0;
	const fakeFetch = async () => {
		calls += 1;

		if (calls === 1) {
			return {
				ok: true,
				text: async () =>
					JSON.stringify({
						output_parsed: {
							translations: [{ id: "a", translation: "甲" }],
						},
					}),
			};
		}

		return {
			ok: true,
			text: async () =>
				JSON.stringify({
					output_parsed: {
						translations: [
							{ id: "a", translation: "甲" },
							{ id: "b", translation: "乙" },
						],
					},
				}),
		};
	};
	const settings = buildSettings({ model: "demo-coverage" });
	const items = [
		{ id: "a", kind: "paragraph", text: "Alpha", protectedFragments: [] },
		{ id: "b", kind: "paragraph", text: "Beta", protectedFragments: [] },
	];

	const result = await requestTranslations({
		settings,
		items,
		fetchImpl: fakeFetch,
	});

	assert.equal(calls, 2);
	assert.deepEqual(result, [
		{ id: "a", translation: "甲" },
		{ id: "b", translation: "乙" },
	]);

	const cached = await requestTranslations({
		settings,
		items: [
			{ id: "c", kind: "paragraph", text: "Alpha", protectedFragments: [] },
			{ id: "d", kind: "paragraph", text: "Beta", protectedFragments: [] },
		],
		fetchImpl: fakeFetch,
	});

	assert.equal(calls, 2);
	assert.deepEqual(cached, [
		{ id: "c", translation: "甲" },
		{ id: "d", translation: "乙" },
	]);
});

test("requestTranslationsBatched runs chunks in parallel and preserves chunk order", async () => {
	clearTranslationCache();

	let inFlight = 0;
	let maxInFlight = 0;
	const delays = {
		a: 50,
		b: 10,
		c: 30,
	};
	const fakeFetch = async (_url, options) => {
		const body = JSON.parse(options.body);
		const item = JSON.parse(body.input[1].content.split("\n\n").at(-1));

		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await new Promise((resolve) => setTimeout(resolve, delays[item.id]));
		inFlight -= 1;

		return {
			ok: true,
			text: async () =>
				JSON.stringify({
					output_parsed: {
						translations: [
							{ id: item.id, translation: `translated-${item.id}` },
						],
					},
				}),
		};
	};

	const result = await requestTranslationsBatched({
		settings: buildSettings(),
		chunks: [
			[{ id: "a", kind: "paragraph", text: "A", protectedFragments: [] }],
			[{ id: "b", kind: "paragraph", text: "B", protectedFragments: [] }],
			[{ id: "c", kind: "paragraph", text: "C", protectedFragments: [] }],
		],
		concurrency: 2,
		fetchImpl: fakeFetch,
	});

	assert.equal(maxInFlight, 2);
	assert.deepEqual(result, [
		{ id: "a", translation: "translated-a" },
		{ id: "b", translation: "translated-b" },
		{ id: "c", translation: "translated-c" },
	]);
});

test("consumeProgressiveTranslations only emits a split segment after all parts are available", () => {
	const plan = createRecursiveChunkPlan(
		[
			{
				id: "long",
				kind: "paragraph",
				text: "First sentence. Second sentence. Third sentence. Fourth sentence.",
			},
		],
		24,
	);
	const state = createProgressiveMergeState(plan);
	const earlyParts = plan.expandedItems.slice(0, -1);
	const finalPart = plan.expandedItems.at(-1);

	const partial = consumeProgressiveTranslations(
		plan,
		state,
		earlyParts.map((item, index) => ({
			id: item.id,
			translation: `第${index + 1}段。`,
		})),
	);

	assert.deepEqual(partial, []);

	const completed = consumeProgressiveTranslations(plan, state, [
		{ id: finalPart.id, translation: "最後一段。" },
	]);

	assert.equal(completed.length, 1);
	assert.equal(completed[0].id, "long");
	assert.equal(getIncompleteSegmentIds(plan, state).length, 0);
});

test("requestTranslationsBatchedProgressive emits chunks in completion order", async () => {
	clearTranslationCache();

	const completionOrder = [];
	const fakeFetch = async (_url, options) => {
		const body = JSON.parse(options.body);
		const item = JSON.parse(body.input[1].content.split("\n\n").at(-1));
		const delays = { a: 40, b: 5, c: 20 };

		await new Promise((resolve) => setTimeout(resolve, delays[item.id]));

		return {
			ok: true,
			text: async () =>
				JSON.stringify({
					output_parsed: {
						translations: [
							{ id: item.id, translation: `translated-${item.id}` },
						],
					},
				}),
		};
	};

	const result = await requestTranslationsBatchedProgressive({
		settings: buildSettings(),
		chunks: [
			[{ id: "a", kind: "paragraph", text: "A", protectedFragments: [] }],
			[{ id: "b", kind: "paragraph", text: "B", protectedFragments: [] }],
			[{ id: "c", kind: "paragraph", text: "C", protectedFragments: [] }],
		],
		concurrency: 3,
		fetchImpl: fakeFetch,
		onChunkResolved: async ({ chunkItems }) => {
			completionOrder.push(chunkItems[0].id);
		},
	});

	assert.deepEqual(completionOrder, ["b", "c", "a"]);
	assert.equal(result.failures.length, 0);
	assert.equal(result.successes.length, 3);
});

test("requestTranslationsBatchedProgressive stops scheduling stale chunks", async () => {
	clearTranslationCache();
	let current = true;
	let requestCount = 0;
	const result = await requestTranslationsBatchedProgressive({
		settings: buildSettings({ model: "stale-progressive-batch" }),
		chunks: ["a", "b", "c"].map((id) => [
			{ id, kind: "paragraph", text: id, protectedFragments: [] },
		]),
		concurrency: 1,
		shouldContinue: () => current,
		async fetchImpl(_url, options) {
			requestCount += 1;
			const body = JSON.parse(options.body);
			const item = JSON.parse(body.input[1].content.split("\n\n").at(-1));
			return {
				ok: true,
				text: async () =>
					JSON.stringify({
						output_parsed: {
							translations: [
								{ id: item.id, translation: `translated-${item.id}` },
							],
						},
					}),
			};
		},
		onChunkResolved() {
			current = false;
		},
	});

	assert.equal(requestCount, 1);
	assert.deepEqual(
		result.successes.map((item) => item.id),
		["a"],
	);
});

test("requestTranslationsBatchedProgressive preserves every id in a grouped subtitle request", async () => {
	clearTranslationCache();

	const plan = createRecursiveChunkPlan(
		Array.from({ length: 8 }, (_, index) => ({
			id: `caption-${index}`,
			kind: "subtitle",
			text: `Caption ${index}`,
		})),
	);
	const chunks = chunkTranslationItems(plan.expandedItems);
	let requestCount = 0;
	const result = await requestTranslationsBatchedProgressive({
		settings: buildSettings({ model: "grouped-subtitles" }),
		chunks,
		concurrency: 5,
		async fetchImpl(_url, options) {
			requestCount += 1;
			const body = JSON.parse(options.body);
			const payload = JSON.parse(body.input[1].content.split("\n\n").at(-1));
			const translations = payload.items.map((item) => ({
				id: item.id,
				translatedText: `translated-${item.id}`,
			}));

			return {
				ok: true,
				text: async () => JSON.stringify({ output_parsed: { translations } }),
			};
		},
	});

	assert.equal(requestCount, 1);
	assert.deepEqual(
		result.successes.map((item) => item.id),
		plan.expandedItems.map((item) => item.id),
	);
});

test("requestTranslationsBatchedProgressive sends one item per request for normal items", async () => {
	clearTranslationCache();

	const plan = createRecursiveChunkPlan(
		[
			{ id: "a", kind: "paragraph", text: "Alpha" },
			{ id: "b", kind: "paragraph", text: "Beta" },
		],
		200,
	);
	const requestPayloadIds = [];
	const fakeFetch = async (_url, options) => {
		const body = JSON.parse(options.body);
		const payload = JSON.parse(body.input[1].content.split("\n\n").at(-1));

		requestPayloadIds.push([payload.id]);

		return {
			ok: true,
			text: async () =>
				JSON.stringify({
					output_parsed: {
						translations: [
							{ id: payload.id, translation: `translated-${payload.id}` },
						],
					},
				}),
		};
	};

	const result = await requestTranslationsBatchedProgressive({
		settings: buildSettings(),
		chunks: plan.chunks,
		concurrency: 2,
		fetchImpl: fakeFetch,
	});

	assert.deepEqual(requestPayloadIds, [["a"], ["b"]]);
	assert.equal(result.failures.length, 0);
	assert.equal(result.successes.length, 2);
});
