#!/usr/bin/env node
/**
 * Publishes prime-linc to npm as @casemark/prime-linc.
 *
 * The monorepo keeps its inherited @earendil-works/pi-* source package names
 * (type resolution uses tsconfig paths, and the esbuild bundle inlines the
 * customized pi-ai/pi-agent-core/pi-tui workspaces). The published package is
 * therefore a single standalone tarball: both the bin entry and the library
 * entry point at the self-contained bundles produced by scripts/bundle.mjs.
 *
 * Usage:
 *   node scripts/publish.mjs [--dry-run]
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = join(repoRoot, "packages", "coding-agent");

const PUBLIC_NAME = "@casemark/prime-linc";
const PUBLIC_COMMAND = "prime-linc";

const dryRun = process.argv.includes("--dry-run");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--dry-run");
if (unknownArgs.length > 0) {
	console.error(`Usage: node scripts/publish.mjs [--dry-run]`);
	process.exit(1);
}

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
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

// Only the real install-time externals. @earendil-works/pi-* are inlined into
// the bundles and must not appear in published dependencies (their 0.x
// versions are not published to npm).
const EXTERNAL_DEPENDENCIES = {
	"@silvia-odwyer/photon-node": "^0.3.4",
	undici: "^7.0.0",
	zeromq: "^6.0.0",
};

const EXTERNAL_OPTIONAL_DEPENDENCIES = {
	"@mariozechner/clipboard": "^0.3.9",
};

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
	manifest.bin = { [PUBLIC_COMMAND]: "dist/bundle/cli.js" };

	// Runtime needs only the native/interop-sensitive externals.
	manifest.dependencies = EXTERNAL_DEPENDENCIES;
	manifest.optionalDependencies = EXTERNAL_OPTIONAL_DEPENDENCIES;

	// No lifecycle scripts in the published package: postinstall would pull in
	// the whole toolchain and the published dist already contains the runtime.
	delete manifest.scripts;
	manifest.scripts = {};

	// Keep the published tarball small: dist bundles are self-contained.
	manifest.files = ["dist/bundle", "dist/bundle-lib", "README.md", "CHANGELOG.md", "LICENSE"];

	manifest.author = "CaseMark";
	manifest.license = "MIT";
	manifest.repository = {
		type: "git",
		url: "git+https://github.com/CaseMark/prime-linc.git",
		directory: "packages/coding-agent",
	};
	manifest.keywords = ["coding-agent", "ai", "llm", "cli", "tui", "agent", "law", "legal", "case.dev"];

	delete manifest.private;
	delete manifest.devDependencies;
	delete manifest.overrides;
	delete manifest.workspaces;

	return manifest;
}

function copyIfExists(sourcePath, destDir) {
	if (!existsSync(sourcePath)) return false;
	run("cp", ["-R", sourcePath, `${destDir}/`], { stdio: "inherit" });
	return true;
}

function stagePackage(source) {
	const stagingDir = mkdtempSync(join(tmpdir(), "prime-linc-publish-"));
	const manifest = createPublishManifest(source);
	writeFileSync(join(stagingDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

	// dist bundles keep their dist/ prefix so the manifest's files list matches.
	run("mkdir", ["-p", join(stagingDir, "dist")], { stdio: "inherit" });
	for (const entry of ["dist/bundle", "dist/bundle-lib"]) {
		run("cp", ["-R", join(packageDir, entry), join(stagingDir, "dist")], { stdio: "inherit" });
	}

	for (const entry of ["README.md", "CHANGELOG.md"]) {
		if (!copyIfExists(join(packageDir, entry), stagingDir)) {
			throw new Error(`${entry} is missing from the coding-agent package; run npm run build first.`);
		}
	}

	const licensePath = join(repoRoot, "LICENSE");
	if (existsSync(licensePath)) {
		run("cp", ["-R", licensePath, `${stagingDir}/`], { stdio: "inherit" });
	} else {
		console.warn("WARNING: no LICENSE at repo root; published package will not include one.");
	}

	return { stagingDir, manifest };
}

function assertBuildOutputs() {
	for (const entry of ["dist/bundle/cli.js", "dist/bundle-lib/index.js"]) {
		if (!existsSync(join(packageDir, entry))) {
			throw new Error(`Missing ${entry}; run npm run build in packages/coding-agent first.`);
		}
	}
}

function isPublished(name, version) {
	const result = spawnSync(commandForPlatform("npm"), ["view", `${name}@${version}`, "version", "--json"], {
		encoding: "utf8",
		stdio: ["inherit", "pipe", "pipe"],
	});

	if (result.status === 0 && result.stdout.trim()) {
		return true;
	}

	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) {
		return false;
	}

	throw new Error(output ? `Failed to query ${name}@${version}\n${output}` : `Failed to query ${name}@${version}`);
}

function validatePack(stagingDir) {
	const result = run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { capture: true, cwd: stagingDir });
	const packed = JSON.parse(result.stdout)[0];
	console.log(`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`);
	return packed;
}

function main() {
	const source = readJson(join(packageDir, "package.json"));
	if (source.private) {
		throw new Error("coding-agent package is marked private; refusing to publish.");
	}
	if (!source.version) {
		throw new Error("coding-agent package has no version.");
	}

	assertBuildOutputs();
	console.log(`Publishing ${PUBLIC_NAME} at ${source.version}${dryRun ? " (dry run)" : ""}\n`);
	const { stagingDir, manifest } = stagePackage(source);
	console.log(`Staged manifest ${manifest.name}@${manifest.version}\n`);

	const published = isPublished(manifest.name, manifest.version);

	if (dryRun) {
		if (published) {
			console.log(`${manifest.name}@${manifest.version} is already published; validating contents only.`);
		} else {
			console.log(`${manifest.name}@${manifest.version} is not published; validating contents before publish.`);
		}
		validatePack(stagingDir);
		rmSync(stagingDir, { recursive: true, force: true });
		return;
	}

	if (published) {
		console.log(`Skipping ${manifest.name}@${manifest.version}: already published`);
		rmSync(stagingDir, { recursive: true, force: true });
		return;
	}

	run("npm", ["publish", "--access", "public", "--provenance", "--ignore-scripts"], { cwd: stagingDir });
	console.log();
	console.log(`Published ${manifest.name}@${manifest.version}`);
	rmSync(stagingDir, { recursive: true, force: true });
}

main();
