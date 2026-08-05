#!/usr/bin/env node
/**
 * Bundles the compiled CLI entry (dist/cli.js) into dist/bundle/ with esbuild.
 *
 * Why: the unbundled module graph is ~2,500 files; resolving and reading them
 * dominates startup (~1.5s on slow filesystems). The bundle loads the same code
 * from ~20 chunk files in under half the time. dist/ stays unbundled for
 * library consumers and type resolution; only the bin entry uses the bundle.
 *
 * Extension loading inside the bundle uses jiti virtualModules (same as the
 * compiled Bun binary), keyed off the __PI_BUNDLED__ define below, so extension
 * imports of pi packages share the bundle's module instances.
 *
 * Two outputs: dist/bundle/ (CLI bin entry) and dist/bundle-lib/ (library
 * consumer entry). Both inline the customized pi-* workspaces so the published
 * package is installable standalone.
 */
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";
import { NPM_BUNDLE_EXTERNALS } from "../../../scripts/npm-package-config.mjs";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cliOutdir = join(packageDir, "dist", "bundle");
const libOutdir = join(packageDir, "dist", "bundle-lib");
let buildId;
try {
	buildId = execFileSync("git", ["describe", "--tags", "--always", "--dirty"], {
		cwd: dirname(packageDir),
		encoding: "utf8",
	}).trim();
} catch {
	buildId = `release-${JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version}`;
}

// Shared esbuild options. The bundle is self-contained: packages/ai,
// packages/agent, and packages/tui are inlined (they are customized forks that
// are not published under their @earendil-works/pi-* names), so a standalone
// npm package only needs the native/interop-sensitive externals below at
// install time.
const external = NPM_BUNDLE_EXTERNALS;
const define = { __PI_BUNDLED__: "true", __PI_BUILD_ID__: JSON.stringify(buildId) };
const banner = {
	js: "import { createRequire as __piBundleCreateRequire } from 'node:module'; const require = __piBundleCreateRequire(import.meta.url);",
};

rmSync(cliOutdir, { recursive: true, force: true });

await build({
	entryPoints: [join(packageDir, "dist", "cli.js")],
	outdir: cliOutdir,
	bundle: true,
	splitting: true,
	format: "esm",
	platform: "node",
	external,
	define,
	banner,
	logLevel: "warning",
});

chmodSync(join(cliOutdir, "cli.js"), 0o755);
console.log("bundled dist/cli.js -> dist/bundle/");

// Library consumers import the package by name; bundle dist/index.js the same
// way so `import "@casemark/prime-linc"` (and its exports map) do not require
// the unpublished @earendil-works/pi-* workspaces at install time.
rmSync(libOutdir, { recursive: true, force: true });

await build({
	entryPoints: [join(packageDir, "dist", "index.js")],
	outdir: libOutdir,
	bundle: true,
	splitting: true,
	format: "esm",
	platform: "node",
	external,
	define,
	banner,
	logLevel: "warning",
});

chmodSync(join(libOutdir, "index.js"), 0o755);

// Bundle the public declarations too. Leaving dist/index.d.ts as-is would make
// consumers resolve the unpublished @earendil-works/pi-* workspace packages.
// Resolve those workspace imports to their built declarations, then let
// rollup-plugin-dts collapse the graph into one standalone public type file.
const workspaceDeclarations = new Map([
	["@earendil-works/pi-ai", join(packageDir, "..", "ai", "dist", "index.d.ts")],
	["@earendil-works/pi-agent-core", join(packageDir, "..", "agent", "dist", "index.d.ts")],
	["@earendil-works/pi-tui", join(packageDir, "..", "tui", "dist", "index.d.ts")],
	["@earendil-works/pi-coding-agent", join(packageDir, "dist", "index.d.ts")],
]);

const workspaceDeclarationAliases = {
	name: "workspace-declaration-aliases",
	resolveId(source) {
		for (const [packageName, entry] of workspaceDeclarations) {
			if (source === packageName) return entry;
			if (!source.startsWith(`${packageName}/`)) continue;

			const declarationRoot = dirname(entry);
			const subpath = source
				.slice(packageName.length + 1)
				.replace(/^dist\//, "")
				.replace(/\.(?:m?js|d\.ts)$/, "");
			for (const candidate of [join(declarationRoot, `${subpath}.d.ts`), join(declarationRoot, subpath, "index.d.ts")]) {
				if (existsSync(candidate)) return candidate;
			}
		}
		return null;
	},
};

const declarationBundle = await rollup({
	input: join(packageDir, "dist", "index.d.ts"),
	external: (id) => id === "events" || id === "typebox" || id.startsWith("node:"),
	plugins: [workspaceDeclarationAliases, dts()],
});
try {
	await declarationBundle.write({ file: join(libOutdir, "index.d.ts"), format: "es" });
} finally {
	await declarationBundle.close();
}

console.log("bundled dist/index.js and declarations -> dist/bundle-lib/");
