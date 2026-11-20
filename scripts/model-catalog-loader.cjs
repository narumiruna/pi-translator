// Factories omit repeated field names and metadata while returning fresh objects.
function encodeModelCatalog(source) {
	const catalog = JSON.parse(source);
	const metadataCounts = new Map();
	const shapeCounts = new Map();
	for (const models of Object.values(catalog)) {
		for (const model of Object.values(models)) {
			const shape = JSON.stringify(Object.keys(model));
			shapeCounts.set(shape, (shapeCounts.get(shape) || 0) + 1);
			for (const value of Object.values(model)) {
				if (value && typeof value === "object") {
					const json = JSON.stringify(value);
					metadataCounts.set(json, (metadataCounts.get(json) || 0) + 1);
				}
			}
		}
	}
	// Factor only values whose repetition outweighs the definition/call overhead.
	const metadataFactories = new Map(
		[...metadataCounts]
			.filter(
				([json, count]) => count * json.length > json.length + 30 + count * 8,
			)
			.map(([json], index) => [json, `value${index}`]),
	);
	const definitions = [...metadataFactories].map(
		([json, name]) => `const ${name}=()=>(${json});`,
	);
	const modelFactories = new Map();
	for (const [shape, count] of shapeCounts) {
		if (count < 2) continue;
		const keys = JSON.parse(shape).map((key) => `${JSON.stringify(key)}:`);
		const parameters = keys.map((_, index) => `p${index}`);
		const name = `shape${modelFactories.size}`;
		const fields = keys.map((key, index) => `${key}${parameters[index]}`);
		const definition = `const ${name}=(${parameters.join(",")})=>({${fields.join(",")}});`;
		const keyLength = keys.reduce((total, key) => total + key.length, 0);
		// Each call replaces the inline keys with the factory name.
		if ((keyLength - name.length) * count <= definition.length + 1) continue;
		modelFactories.set(shape, name);
		definitions.push(definition);
	}
	const encodeModel = (model) => {
		const keys = Object.keys(model);
		const values = Object.values(model).map((value) => {
			const json = JSON.stringify(value);
			const factory = metadataFactories.get(json);
			return factory ? `${factory}()` : json;
		});
		const factory = modelFactories.get(JSON.stringify(keys));
		if (factory) return `${factory}(${values.join(",")})`;
		return `{${keys
			.map((key, index) => `${JSON.stringify(key)}:${values[index]}`)
			.join(",")}}`;
	};
	const groups = Object.entries(catalog)
		.map(
			([api, models]) =>
				`${JSON.stringify(api)}:{${Object.entries(models)
					.map(([id, model]) => `${JSON.stringify(id)}:${encodeModel(model)}`)
					.join(",")}}`,
		)
		.join(",");
	return `${definitions.join("\n")}\nexport default {${groups}};`;
}

module.exports = encodeModelCatalog;
module.exports.encodeModelCatalog = encodeModelCatalog;
