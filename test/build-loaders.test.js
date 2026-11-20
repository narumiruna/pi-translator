import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { test } from "vitest";

const require = createRequire(import.meta.url);
const { encodeModelCatalog } = require("../scripts/model-catalog-loader.cjs");
const { trimTextSdk } = require("../scripts/text-sdk-loader.cjs");

function decodeCatalog(source) {
	const sandbox = { module: { exports: {} } };
	runInNewContext(
		encodeModelCatalog(source).replace("export default", "module.exports ="),
		sandbox,
	);
	return sandbox.module.exports;
}

const metadata = {
	image: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592 } },
};

test("catalog encoding preserves all installed model metadata", async () => {
	const directory = path.join(
		path.dirname(
			fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/providers/all")),
		),
		"data",
	);
	for (const file of await readdir(directory)) {
		if (!/^[a-z].*\.json$/u.test(file)) continue;
		const source = await readFile(path.join(directory, file), "utf8");
		assert.deepEqual(
			JSON.parse(JSON.stringify(decodeCatalog(source))),
			JSON.parse(source),
			file,
		);
	}
});

test("catalog factories keep repeated model metadata independently mutable", () => {
	const source = JSON.stringify({
		chat: {
			first: { id: "first", inputLimits: metadata, maxOutputTokens: 1000 },
			second: { id: "second", inputLimits: metadata, maxOutputTokens: 1000 },
			third: { id: "third", inputLimits: metadata, maxOutputTokens: 1000 },
			fourth: { id: "fourth", inputLimits: metadata, maxOutputTokens: 1000 },
		},
	});
	assert.match(encodeModelCatalog(source), /const value/u);
	const catalog = decodeCatalog(source);
	catalog.chat.first.inputLimits.image.resize.maxWidth = 1;
	assert.equal(catalog.chat.second.inputLimits.image.resize.maxWidth, 2000);
});

test("catalog encoding stores repeated model field names once", () => {
	const chat = Object.fromEntries(
		Array.from({ length: 12 }, (_, index) => [
			`model-${index}`,
			{
				id: `model-${index}`,
				name: `Example ${index}`,
				supportsReasoning: false,
				contextWindow: 100_000,
				maxOutputTokens: 10_000,
			},
		]),
	);
	chat.custom = { id: "custom", contextWindow: null };
	const source = JSON.stringify({ chat });
	const encoded = encodeModelCatalog(source);
	assert.equal(encoded.match(/maxOutputTokens/gu)?.length, 1);
	assert.equal(JSON.stringify(decodeCatalog(source)), source);
});

test("catalog encoding handles empty groups, arrays, and escaped strings", () => {
	const catalog = {
		empty: {},
		chat: {
			example: {
				id: 'quoted"id',
				input: ["text", "image"],
				name: "日本語\ntext",
			},
		},
	};
	assert.deepEqual(
		JSON.parse(JSON.stringify(decodeCatalog(JSON.stringify(catalog)))),
		catalog,
	);
});

const sdkSource = `
const API = {
 Text: class { create() { return "translated"; } },
 Images: class { constructor() { throw new Error("Unused SDK resource constructed"); } },
};
export class Client {
 constructor() {
  this.options = { timeout: 100 };
  this.text = new API.Text(this);
  this.images = new API.Images(this);
 }
 create() { return this.text.create(); }
}
Client.Text = API.Text;
Client.Images = API.Images;
Client.APIError = Error;
`;

function importSource(source) {
	return import(
		`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
	);
}

test("SDK trimming retains text resources, auth configuration, and errors", async () => {
	const output = trimTextSdk(sdkSource, {
		className: "Client",
		namespaceResources: true,
		resources: ["text"],
	});
	const { Client } = await importSource(output);
	const client = new Client();
	assert.equal(client.create(), "translated");
	assert.equal(client.options.timeout, 100);
	assert.equal(client.images, undefined);
	assert.equal(Client.Images, undefined);
	assert.equal(Client.APIError, Error);
	assert.equal(typeof Client.Text, "function");
});

test("SDK trimming handles exported classes wrapped in an IIFE", async () => {
	const source = `
const API = {
 Text: class { create() { return "translated"; } },
 Images: class { constructor() { throw new Error("Unused resource"); } },
};
export var Client = /* @__PURE__ */ (() => {
 class Client {
  constructor() {
   this.options = { timeout: 100 };
   this.text = new API.Text(this);
   this.images = new API.Images(this);
  }
  create() { return this.text.create(); }
 }
 Client.Text = API.Text;
 Client.Images = API.Images;
 Client.AuthenticationError = Error;
 return Client;
})();`;
	const output = trimTextSdk(source, {
		className: "Client",
		namespaceResources: true,
		resources: ["text"],
		methods: ["constructor", "create"],
	});
	const { Client } = await importSource(output);
	const client = new Client();
	assert.equal(client.create(), "translated");
	assert.equal(client.options.timeout, 100);
	assert.equal(client.images, undefined);
	assert.equal(Client.Images, undefined);
	assert.equal(Client.AuthenticationError, Error);
	assert.equal(typeof Client.Text, "function");
});

test("SDK trimming preserves required constructor functions and helpers", async () => {
	const source = `export class Models {
 constructor() {
  this.generateContentStream = () => this.helper();
  this.generateImages = () => "image";
 }
 helper() { return "translated"; }
 get agents() { throw new Error("Unused getter"); }
}`;
	const output = trimTextSdk(source, {
		className: "Models",
		methods: ["constructor", "generateContentStream", "helper"],
	});
	const { Models } = await importSource(output);
	const models = new Models();
	assert.equal(models.generateContentStream(), "translated");
	assert.equal(models.generateImages, undefined);
	assert.equal(models.agents, undefined);
});

test("SDK trimming fails visibly when required upstream APIs change", () => {
	assert.throws(
		() => trimTextSdk(sdkSource, { className: "Missing", resources: [] }),
		/class not found/u,
	);
	assert.throws(
		() =>
			trimTextSdk(sdkSource, {
				className: "Client",
				namespaceResources: true,
				resources: ["missing"],
			}),
		/resource not found/u,
	);
	assert.throws(
		() =>
			trimTextSdk(sdkSource, {
				className: "Client",
				methods: ["constructor", "missing"],
			}),
		/method not found/u,
	);
});
