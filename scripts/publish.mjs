#!/usr/bin/env node
/**
 * Builds and validates the @casemark/prime-linc npm-compatible release tarball.
 *
 * The monorepo keeps its inherited @earendil-works/pi-* source package names
 * (type resolution uses tsconfig paths, and the esbuild bundle inlines the
 * customized pi-ai/pi-agent-core/pi-tui workspaces). The published package is
 * therefore a single standalone tarball: both the bin entry and the library
 * entry point at the self-contained bundles produced by scripts/bundle.mjs.
 *
 * Publishing is intentionally performed by the locked-down GitHub Release job,
 * which receives the already-validated tarball and never checks out or executes
 * repository code with release credentials.
 *
 * Usage:
 *   node scripts/publish.mjs --dry-run
 *   node scripts/publish.mjs --pack <output.tgz>
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NPM_BUNDLE_EXTERNALS } from "./npm-package-config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = join(repoRoot, "packages", "coding-agent");

const PUBLIC_NAME = "@casemark/prime-linc";
const PUBLIC_COMMAND = "prime-linc";

const args = process.argv.slice(2);
const dryRun = args.length === 1 && args[0] === "--dry-run";
const packOutput = args.length === 2 && args[0] === "--pack" ? resolve(args[1]) : undefined;
if (!dryRun && !packOutput) {
	console.error("Usage: node scripts/publish.mjs --dry-run | --pack <output.tgz>");
	process.exit(1);
}

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const childEnv = { ...process.env };
	// Package validation executes the staged CLI and npm install. Never forward
	// registry credentials if a caller happens to have them in its environment.
	delete childEnv.NODE_AUTH_TOKEN;
	delete childEnv.NPM_TOKEN;
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
		env: childEnv,
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(output ? `Command failed: ${command} ${args.join(" ")}\n${output}` : `Command failed: ${command} ${args.join(" ")}`);
	}

	return result;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

// @earendil-works/pi-* are bundled and must not appear in the public
// dependency graph. Native/interop-sensitive externals retain the exact ranges
// declared by their source workspaces so packaging cannot silently drift.
function declaredVersion(manifest, section, name, manifestName) {
	const version = manifest[section]?.[name];
	if (!version) throw new Error(`${manifestName} is missing ${section}.${name}`);
	return version;
}

function createPublishManifest(source) {
	const manifest = { ...source };

	manifest.name = PUBLIC_NAME;
	manifest.version = source.version;
	manifest.description = source.description || "case.dev-native RLM agent harness (prime-linc)";

	// Standalone bundles only. The library bundle is self-contained (pi-* inlined).
	manifest.main = "./dist/bundle-lib/index.js";
	manifest.types = "./dist/bundle-lib/index.d.ts";
	manifest.exports = {
		".": {
			types: "./dist/bundle-lib/index.d.ts",
			import: "./dist/bundle-lib/index.js",
		},
	};
	// prime-linc is the canonical command. `linc` keeps the Bastion bridge and
	// existing CaseMark automation compatible; `pi` preserves the upstream CLI
	// alias for users migrating from pi-mono.
	manifest.bin = {
		[PUBLIC_COMMAND]: "dist/bundle/cli.js",
		linc: "dist/bundle/cli.js",
		pi: "dist/bundle/cli.js",
	};

	// Runtime needs only native/interop-sensitive externals plus typebox, which
	// is referenced by the standalone public declaration bundle.
	const rootManifest = readJson(join(repoRoot, "package.json"));
	const tuiManifest = readJson(join(repoRoot, "packages", "tui", "package.json"));
	manifest.dependencies = {
		"@silvia-odwyer/photon-node": declaredVersion(
			source,
			"dependencies",
			"@silvia-odwyer/photon-node",
			"coding-agent",
		),
		"@types/node": declaredVersion(rootManifest, "devDependencies", "@types/node", "root"),
		typebox: declaredVersion(source, "dependencies", "typebox", "coding-agent"),
		undici: declaredVersion(source, "dependencies", "undici", "coding-agent"),
		zeromq: declaredVersion(source, "dependencies", "zeromq", "coding-agent"),
	};
	manifest.optionalDependencies = {
		"@mariozechner/clipboard": declaredVersion(
			source,
			"optionalDependencies",
			"@mariozechner/clipboard",
			"coding-agent",
		),
		koffi: declaredVersion(tuiManifest, "optionalDependencies", "koffi", "tui"),
	};
	for (const external of NPM_BUNDLE_EXTERNALS) {
		if (!manifest.dependencies[external] && !manifest.optionalDependencies[external]) {
			throw new Error(`Bundled external ${external} is missing from the published dependency manifest.`);
		}
	}

	// No lifecycle scripts in the published package: postinstall would pull in
	// the whole toolchain and the published dist already contains the runtime.
	delete manifest.scripts;
	manifest.scripts = {};

	// The JS runtime is bundled, while themes, templates, Python sources, skills,
	// and examples remain disk-loaded assets. Root skills/docs are also retained
	// for package consumers and Bastion's derived sandbox image.
	manifest.files = [
		"dist/bundle",
		"dist/bundle-lib",
		"dist/core/export-html",
		"dist/modes/interactive/assets",
		"dist/modes/interactive/theme",
		"dist/prime-agent-runtime",
		"dist/skills",
		"skills",
		"examples",
		"docs",
		"README.md",
		"CHANGELOG.md",
		"LICENSE",
	];

	manifest.author = "CaseMark";
	manifest.license = "MIT";
	manifest.repository = {
		type: "git",
		url: "git+https://github.com/CaseMark/prime-linc.git",
		directory: "packages/coding-agent",
	};
	manifest.homepage = "https://github.com/CaseMark/prime-linc#readme";
	manifest.bugs = { url: "https://github.com/CaseMark/prime-linc/issues" };
	manifest.keywords = ["coding-agent", "ai", "llm", "cli", "tui", "agent", "law", "legal", "case.dev"];

	delete manifest.private;
	delete manifest.devDependencies;
	delete manifest.overrides;
	delete manifest.workspaces;

	return manifest;
}

function copyIfExists(sourcePath, destDir) {
	if (!existsSync(sourcePath)) return false;
	cpSync(sourcePath, join(destDir, basename(sourcePath)), { recursive: true });
	return true;
}

function removePythonCaches(root) {
	if (!existsSync(root)) return;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) {
			rmSync(path, { recursive: true, force: true });
		} else if (entry.isDirectory()) {
			removePythonCaches(path);
		}
	}
}

function stagePackage(source) {
	const stagingDir = mkdtempSync(join(tmpdir(), "prime-linc-publish-"));
	const manifest = createPublishManifest(source);
	writeFileSync(join(stagingDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

	// Preserve the exact dist-relative paths used by config.ts. The JS is
	// bundled, but themes, images, export templates, Python runtime sources, and
	// built-in skills are loaded from disk at runtime.
	for (const entry of [
		"dist/bundle",
		"dist/bundle-lib",
		"dist/core/export-html",
		"dist/modes/interactive/assets",
		"dist/modes/interactive/theme",
		"dist/prime-agent-runtime",
		"dist/skills",
	]) {
		const sourcePath = join(packageDir, entry);
		if (!existsSync(sourcePath)) {
			throw new Error(`${entry} is missing from the coding-agent package; run npm run build first.`);
		}
		const destination = join(stagingDir, entry);
		mkdirSync(dirname(destination), { recursive: true });
		cpSync(sourcePath, destination, { recursive: true });
	}

	for (const entry of ["skills", "examples", "docs", "README.md", "CHANGELOG.md"]) {
		if (!copyIfExists(join(packageDir, entry), stagingDir)) {
			throw new Error(`${entry} is missing from the coding-agent package; run npm run build first.`);
		}
	}

	const licensePath = join(repoRoot, "LICENSE");
	if (existsSync(licensePath)) {
		cpSync(licensePath, join(stagingDir, "LICENSE"));
	} else {
		throw new Error("LICENSE is missing from the repository root.");
	}

	removePythonCaches(stagingDir);
	return { stagingDir, manifest };
}

function assertBuildOutputs() {
	for (const entry of [
		"dist/bundle/cli.js",
		"dist/bundle-lib/index.js",
		"dist/bundle-lib/index.d.ts",
		"dist/core/export-html/template.html",
		"dist/modes/interactive/assets/clankolas.png",
		"dist/modes/interactive/theme/prime.json",
		"dist/prime-agent-runtime/pyproject.toml",
		"dist/skills/websearch/SKILL.md",
	]) {
		if (!existsSync(join(packageDir, entry))) {
			throw new Error(`Missing ${entry}; run npm run build in packages/coding-agent first.`);
		}
	}
}

function packAndSmoke(stagingDir, manifest) {
	const result = run("npm", ["pack", "--ignore-scripts", "--json"], { capture: true, cwd: stagingDir });
	const packed = JSON.parse(result.stdout)[0];
	const cacheEntries = packed.files.filter(
		(file) => file.path.includes("/__pycache__/") || file.path.endsWith(".pyc"),
	);
	if (cacheEntries.length > 0) {
		throw new Error(`Packed package contains Python cache files: ${cacheEntries.map((file) => file.path).join(", ")}`);
	}
	console.log(
		`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`,
	);

	const installDir = mkdtempSync(join(tmpdir(), "prime-linc-install-smoke-"));
	try {
		writeFileSync(
			join(installDir, "package.json"),
			`${JSON.stringify({ name: "prime-linc-install-smoke", private: true }, null, 2)}\n`,
		);
		const tarball = join(stagingDir, packed.filename);
		run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: installDir });

		const binDir = join(installDir, "node_modules", ".bin");
		for (const command of ["prime-linc", "linc", "pi"]) {
			const binPath = commandForPlatform(join(binDir, command));
			if (!existsSync(binPath)) {
				throw new Error(`Packed package is missing the ${command} binary alias.`);
			}
		}

		const versionResult = run(join(binDir, "prime-linc"), ["--version"], { capture: true, cwd: installDir });
		// The CLI writes help/version output through its terminal logger (stderr).
		// Ignore Node warnings and require an exact version line in either stream.
		const versionLines = `${versionResult.stdout ?? ""}\n${versionResult.stderr ?? ""}`
			.split(/\r?\n/)
			.map((line) => line.trim());
		if (!versionLines.includes(manifest.version)) {
			throw new Error(`Installed prime-linc did not report expected version ${manifest.version}.`);
		}
		const version = manifest.version;

		run(
			"node",
			[
				"--input-type=module",
				"-e",
				`const m=await import(${JSON.stringify(manifest.name)}); if(typeof m.createAgentSession!=="function") throw new Error("createAgentSession export missing"); m.initTheme("dark");`,
			],
			{ cwd: installDir },
		);

		const typeSmoke = join(installDir, "smoke.mts");
		writeFileSync(
			typeSmoke,
			`import { createAgentSession } from ${JSON.stringify(manifest.name)};\nconst typed: typeof createAgentSession = createAgentSession;\nvoid typed;\n`,
		);
		run(
			join(repoRoot, "node_modules", ".bin", "tsc"),
			[
				"--noEmit",
				"--strict",
				"--skipLibCheck",
				"false",
				"--target",
				"ES2022",
				"--module",
				"NodeNext",
				"--moduleResolution",
				"NodeNext",
				"--types",
				"node",
				typeSmoke,
			],
			{ cwd: installDir },
		);

		const installedRoot = join(installDir, "node_modules", ...manifest.name.split("/"));
		for (const asset of [
			"dist/core/export-html/template.html",
			"dist/modes/interactive/assets/clankolas.png",
			"dist/modes/interactive/theme/prime.json",
			"dist/prime-agent-runtime/pyproject.toml",
			"dist/skills/websearch/SKILL.md",
			"skills/websearch/SKILL.md",
			"examples/extensions/subagent/index.ts",
			"docs/quickstart.md",
		]) {
			if (!existsSync(join(installedRoot, asset))) {
				throw new Error(`Packed package is missing runtime asset ${asset}.`);
			}
		}
		console.log(
			`  install smoke: ${manifest.name}@${version}, JS and TypeScript imports, theme/assets, Python runtime, skills, docs, three CLI aliases`,
		);
	} finally {
		rmSync(installDir, { recursive: true, force: true });
	}

	return packed;
}

function main() {
	const source = readJson(join(packageDir, "package.json"));
	if (source.private) {
		throw new Error("coding-agent package is marked private; refusing to pack.");
	}
	if (!source.version) {
		throw new Error("coding-agent package has no version.");
	}

	assertBuildOutputs();
	console.log(`Packing ${PUBLIC_NAME} at ${source.version}${dryRun ? " (dry run)" : ""}\n`);
	const { stagingDir, manifest } = stagePackage(source);
	try {
		console.log(`Staged manifest ${manifest.name}@${manifest.version}\n`);
		const packed = packAndSmoke(stagingDir, manifest);
		if (packOutput) {
			mkdirSync(dirname(packOutput), { recursive: true });
			copyFileSync(join(stagingDir, packed.filename), packOutput);
			console.log(`\nValidated release tarball: ${packOutput}`);
		} else {
			console.log(`\nValidated ${manifest.name}@${manifest.version}; nothing was published.`);
		}
	} finally {
		rmSync(stagingDir, { recursive: true, force: true });
	}
}

main();
