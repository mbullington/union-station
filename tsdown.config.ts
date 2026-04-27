import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts"],
	format: "esm",
	platform: "browser",
	target: "esnext",
	sourcemap: false,
	dts: {
		sourcemap: false,
	},
	clean: true,
});
