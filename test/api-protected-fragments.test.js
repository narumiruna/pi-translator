import assert from "node:assert/strict";
import { test } from "vitest";

import {
	maskProtectedFragments,
	unmaskProtectedFragments,
	validateProtectedFragments,
} from "../src/translation/protected-fragments.js";

test("protected fragment masking preserves code paths urls and tech terms", () => {
	const masked = maskProtectedFragments(
		"Run `npm test` in src/app/ and open https://example.com for GitHub API docs.",
	);

	assert.equal(masked.maskedText.includes("`npm test`"), false);
	assert.ok(masked.tokens.length >= 4);
	assert.equal(
		unmaskProtectedFragments(masked.maskedText, masked.tokens),
		"Run `npm test` in src/app/ and open https://example.com for GitHub API docs.",
	);
});

test("salary ranges and multiple prices are protected as complete fragments", () => {
	for (const [text, values] of [
		["$50–$150/hr", ["$50–$150/hr"]],
		[
			"Pay $50-$150/hr, $200/day, and $1,000.50 per week.",
			["$50-$150/hr", "$200/day", "$1,000.50"],
		],
		[
			"Prices are $5, $10, and $15. Use $2x + 1$ or $2 + 3$ or $p(x)$.",
			["$5", "$10", "$15", "$2x + 1$", "$2 + 3$", "$p(x)$"],
		],
	]) {
		const masked = maskProtectedFragments(text);
		assert.equal(
			unmaskProtectedFragments(masked.maskedText, masked.tokens),
			text,
		);
		assert.deepEqual(
			masked.tokens.map(({ value }) => value),
			values,
		);
	}
});

test("masking does not nest generated or pre-extracted placeholders", () => {
	const existing = [
		{ placeholder: "__OT_MATH_1__", value: "$x$", preservePlaceholder: true },
	];
	const text =
		"`$x$ and API` __OT_MATH_1__/docs src/app.js https://example.com/API";
	const masked = maskProtectedFragments(text, existing);
	assert.ok(masked.tokens.some(({ value }) => value === "`$x$ and API`"));
	assert.ok(
		masked.tokens.slice(1).every(({ value }) => !value.includes("__OT_")),
	);
	assert.equal(
		unmaskProtectedFragments(masked.maskedText, masked.tokens),
		text,
	);
	const repeated = maskProtectedFragments(masked.maskedText, masked.tokens);
	assert.deepEqual(repeated, masked);
});

test("literal placeholder examples do not collide with generated tokens", () => {
	for (const text of [
		"Use `__OT_TOKEN_1__` with API.",
		"`__OT_TOKEN_1__`",
		"`__OT_TOKEN_X__` and __OT_MATH_42__",
		"A malformed example: __OT_TOKEN_1_ with API.",
	]) {
		const masked = maskProtectedFragments(text);
		validateProtectedFragments(
			[
				{
					id: "literal",
					text: masked.maskedText,
					protectedFragments: masked.tokens,
				},
			],
			[{ id: "literal", translation: masked.maskedText }],
		);
		assert.equal(
			unmaskProtectedFragments(masked.maskedText, masked.tokens),
			text,
		);
	}
});

test("restoration resolves nested tokens independent of token order", () => {
	const tokens = [
		{ placeholder: "__OT_TOKEN_1__", value: "$50–$" },
		{ placeholder: "__OT_TOKEN_2__", value: "__OT_TOKEN_1__150/hr" },
	];
	for (const ordered of [tokens, [...tokens].reverse()]) {
		assert.equal(
			unmaskProtectedFragments("__OT_TOKEN_2__", ordered),
			"$50–$150/hr",
		);
	}
});

test("restoration fails safely on unknown malformed and cyclic tokens", () => {
	for (const text of ["__OT_TOKEN_99__", "__OT_TOKEN_X__", "__OT_TOKEN_1_"]) {
		assert.throws(
			() => unmaskProtectedFragments(text, []),
			/Protected placeholder/,
		);
	}
	assert.throws(
		() =>
			unmaskProtectedFragments("__OT_TOKEN_1__", [
				{ placeholder: "__OT_TOKEN_1__", value: "__OT_TOKEN_2__" },
				{ placeholder: "__OT_TOKEN_2__", value: "__OT_TOKEN_1__" },
			]),
		/Protected placeholder/,
	);
});

test("validation rejects extra duplicated and malformed placeholders", () => {
	const items = [
		{
			id: "a",
			text: "__OT_TOKEN_1__",
			protectedFragments: [{ placeholder: "__OT_TOKEN_1__", value: "API" }],
		},
	];
	for (const translation of [
		"__OT_TOKEN_1__ __OT_TOKEN_99__",
		"__OT_TOKEN_1__ __OT_TOKEN_1__",
		"__OT_TOKEN_1__ __OT_TOKEN_X__",
		"__OT_TOKEN_1__ __OT_MATH_99__",
	]) {
		assert.throws(
			() => validateProtectedFragments(items, [{ id: "a", translation }]),
			/Protected placeholder/,
		);
	}
	validateProtectedFragments(items, [
		{ id: "a", translation: "Use __OT_TOKEN_1__." },
	]);
});

test("protected fragment validation rejects missing placeholders", () => {
	assert.throws(
		() =>
			validateProtectedFragments(
				[
					{
						id: "a",
						protectedFragments: [{ placeholder: "__OT_TOKEN_1__" }],
					},
				],
				[{ id: "a", translation: "missing" }],
			),
		/Protected placeholder missing/,
	);
});
