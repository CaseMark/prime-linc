import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { describeKernelExit, KernelManager } from "../src/core/kernel/index.js";
import { snapshotPathIn } from "../src/core/kernel/state-snapshot.js";
import { createIpythonToolDefinition, IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

function resolveKernelPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import ipykernel, dill"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveKernelPython();
const describeIfKernel = python ? describe : describe.skip;

// Default to direct spawn so the kernel is a child and its exit signal is observable; tests opt into the forkserver.
const savedForkFlag = process.env.PRIME_AGENT_KERNEL_FORKSERVER;
beforeAll(() => {
	process.env.PRIME_AGENT_KERNEL_FORKSERVER = "0";
});
afterAll(() => {
	if (savedForkFlag === undefined) delete process.env.PRIME_AGENT_KERNEL_FORKSERVER;
	else process.env.PRIME_AGENT_KERNEL_FORKSERVER = savedForkFlag;
});

function textOf(result: { content: { type: string; text?: string }[] }): string {
	const first = result.content[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

/** Kernel pid printed as the last line of a cell; never 0/1, which would signal a process group or init. */
function kernelPid(output: string): number {
	const pid = Number(/(\d+)\s*$/.exec(output)?.[1]);
	if (!Number.isInteger(pid) || pid <= 1) throw new Error(`no kernel pid in output: ${output}`);
	return pid;
}

describeIfKernel("ipython kernel crash restart (real kernel)", () => {
	let dir = "";
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-linc-kernel-crash-"));
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it.each([
		["direct spawn", "0"],
		["forkserver", "1"],
	])(
		"restarts a kernel killed mid-cell and revives the last snapshot (%s)",
		async (_mode, forkFlag) => {
			process.env.PRIME_AGENT_KERNEL_FORKSERVER = forkFlag;
			const snapshotDir = join(dir, "artifacts");
			provisioner = new IpythonKernelProvisioner(dir, { python: python as string, snapshotDir });
			const tool = createIpythonToolDefinition(dir, { provisioner });
			const ctx = {} as ExtensionContext;
			const run = (code: string) => tool.execute("call", { code }, undefined, undefined, ctx);

			const pid = kernelPid(textOf(await run("import os\nx = 41\nprint(os.getpid())")));
			const manager = await provisioner.ensure();
			expect(await manager.snapshotState()).not.toBeNull();
			expect(existsSync(snapshotPathIn(snapshotDir))).toBe(true);

			const running = run("import time\ntime.sleep(30)");
			await new Promise((r) => setTimeout(r, 500));
			process.kill(pid, "SIGKILL");
			const crashed = await running.then(
				() => "",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
			expect(crashed).toContain("IPython kernel exited unexpectedly");
			expect(crashed).toContain("The next ipython call starts a new kernel");
			if (forkFlag === "0") {
				expect(crashed).toContain("signal=SIGKILL");
				expect(crashed).toContain("ran out of memory");
			}

			const recovered = await run("print(x + 1)");
			const text = textOf(recovered);
			expect(recovered.details.status).toBe("ok");
			expect(recovered.details.kernelRestarted).toBe(true);
			expect(text).toContain("<ipython_kernel_reset>");
			expect(text).toContain("exited unexpectedly");
			expect(text).toMatch(/Restored from the last saved state: .*\bx\b/);
			expect(text).toContain("42");

			const next = await run("print('still up')");
			expect(textOf(next)).not.toContain("<ipython_kernel_reset>");
			expect(next.details.kernelRestarted).toBe(false);
		},
		60_000,
	);

	it("stops replacing a crashed kernel after the restart cap", async () => {
		process.env.PRIME_AGENT_KERNEL_FORKSERVER = "0";
		provisioner = new IpythonKernelProvisioner(dir, { python: python as string });
		const tool = createIpythonToolDefinition(dir, { provisioner });
		const ctx = {} as ExtensionContext;
		const run = (code: string) => tool.execute("call", { code }, undefined, undefined, ctx);

		for (let crash = 0; crash < 4; crash++) {
			const pid = kernelPid(textOf(await run("import os\nprint(os.getpid())")));
			process.kill(pid, "SIGKILL");
			await expect.poll(() => provisioner?.manager?.unexpectedExit).toContain("signal=SIGKILL");
			if (crash === 3) {
				expect(provisioner.canRestartAfterCrash).toBe(false);
			}
		}
		await expect(run("print(1)")).rejects.toThrow("will not be restarted again");
	}, 120_000);
});

describe("describeKernelExit", () => {
	it("attributes a recorded cgroup OOM kill", () => {
		expect(describeKernelExit("forked kernel process is gone, oom_kill")).toContain("ran out of memory");
	});

	it("flags an external SIGKILL as a likely OOM kill", () => {
		expect(describeKernelExit("code=null signal=SIGKILL")).toContain(
			"most likely because the machine ran out of memory",
		);
	});

	it("leaves other exits as reported", () => {
		expect(describeKernelExit("code=1 signal=null")).toBe("code=1 signal=null");
	});
});

describeIfKernel("kernel snapshot cooldown (real kernel)", () => {
	let dir = "";
	let manager: KernelManager | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-linc-snapshot-cooldown-"));
	});

	afterEach(async () => {
		await manager?.dispose();
		manager = undefined;
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("defers the auto-snapshot after a slow snapshot, then resumes", async () => {
		const path = join(dir, "kernel-state.dill");
		manager = new KernelManager({
			python: python as string,
			cwd: dir,
			snapshot: { path, manifestPath: join(dir, "kernel-state.json"), debounceMs: 50 },
		});
		const internals = manager as unknown as { lastSnapshotDurationMs: number; lastSnapshotFinishedAt: number };

		// Pretend the previous snapshot took 60 s: the next one waits ~10 min.
		await manager.start();
		internals.lastSnapshotDurationMs = 60_000;
		internals.lastSnapshotFinishedAt = Date.now();
		await manager.execute("x = 1");
		await new Promise((r) => setTimeout(r, 500));
		expect(existsSync(path)).toBe(false);

		internals.lastSnapshotDurationMs = 0;
		await manager.execute("y = 2");
		await expect.poll(() => existsSync(path), { timeout: 10_000 }).toBe(true);
	}, 60_000);
});
