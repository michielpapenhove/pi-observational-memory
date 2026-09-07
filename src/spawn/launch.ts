/**
 * Subprocess worker launch — the yt-edit `pi -e <ext> -p` pattern (L2).
 *
 * NOT the subagents extension: that uses `--no-session --mode json`, which would defeat
 * decision 11's requirement that every worker be an ordinary recorded GLOBAL session. We
 * spawn a plain headless `pi` with no `--session-dir`, so the run is recorded under the
 * project path in `~/.pi/agent/sessions` and is openable in the session browser.
 */
import { spawn } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { ConfiguredModel } from "../config.js";
import { runCostPath, runResultPath, runsDir } from "./runs.js";
import { atomicWrite } from "../memory/paths.js";
import type { WorkerRequest } from "./receipt.js";

/** Repo root = two levels up from src/spawn/. The shared agent extension lives at agent/index.ts. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const AGENT_EXTENSION_PATH = join(REPO_ROOT, "agent", "index.ts");

export function modelArg(model: ConfiguredModel): string {
	return `${model.provider}/${model.id}`;
}

/** Resolve the `pi` entry point (subagents' trick), falling back to `pi` on PATH. */
export function resolvePiBinary(): { command: string; baseArgs: string[] } {
	const entry = process.argv[1];
	if (entry) {
		try {
			const realEntry = realpathSync(entry);
			if (/\.(?:mjs|cjs|js)$/i.test(realEntry)) {
				return { command: process.execPath, baseArgs: [realEntry] };
			}
		} catch {
			// fall through
		}
	}
	return { command: "pi", baseArgs: [] };
}

export function buildWorkerArgv(opts: {
	model: ConfiguredModel;
	sessionName: string;
	/** For small callers/tests only. Real workers receive the recorded prompt via stdin. */
	kickoffPrompt?: string;
	agentExtensionPath?: string;
}): string[] {
	const pi = resolvePiBinary();
	const args = [
		...pi.baseArgs,
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-builtin-tools",
		"--model",
		modelArg(opts.model),
	];
	if (opts.model.thinking) args.push("--thinking", opts.model.thinking);
	args.push("-e", opts.agentExtensionPath ?? AGENT_EXTENSION_PATH);
	args.push("-n", opts.sessionName);
	args.push("-p");
	if (opts.kickoffPrompt !== undefined) args.push(opts.kickoffPrompt);
	return [pi.command, ...args];
}

export type WorkerExit = { code: number | null; signal: NodeJS.Signals | null; stderr: string; timedOut?: boolean; aborted?: boolean };

/**
 * Spawn a headless worker; resolve when it exits. Workers run in their master session's
 * `.memory/<sessionId>/` root (not the project cwd) so pi keys the run into a distinct global
 * session bucket and it never clutters the project's `/resume` picker. The root is ensured to
 * exist before spawn — `spawn()` would ENOENT otherwise (the memory root is created lazily on
 * first durable write when there is no parent to seed).
 */
export function spawnWorker(opts: {
	argv: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	input?: string;
	timeoutMs?: number;
	killGraceMs?: number;
}): Promise<WorkerExit> {
	if (opts.signal?.aborted) return Promise.resolve({ code: null, signal: null, stderr: "cancelled before spawn", aborted: true });
	const [command, ...rest] = opts.argv;
	mkdirSync(opts.cwd, { recursive: true });
	return new Promise<WorkerExit>((resolvePromise) => {
		const proc = spawn(command, rest, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "ignore", "pipe"] });
		let stderr = Buffer.alloc(0);
		let closed = false;
		let timedOut = false;
		let aborted = false;
		let escalation: ReturnType<typeof setTimeout> | undefined;
		const stop = () => {
			if (closed || escalation) return;
			proc.kill("SIGTERM");
			escalation = setTimeout(() => {
				if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
			}, opts.killGraceMs ?? 3000);
			escalation.unref?.();
		};
		const abort = () => { aborted = true; stop(); };
		const deadline = setTimeout(() => { timedOut = true; stop(); }, opts.timeoutMs ?? 15 * 60_000);
		deadline.unref?.();
		opts.signal?.addEventListener("abort", abort, { once: true });
		proc.stderr.on("data", (d: Buffer) => { stderr = Buffer.concat([stderr, d]).subarray(-16_384); });
		proc.on("error", (error) => { stderr = Buffer.from(error.message).subarray(-16_384); });
		proc.on("close", (code, signal) => {
			closed = true;
			clearTimeout(deadline);
			if (escalation) clearTimeout(escalation);
			opts.signal?.removeEventListener("abort", abort);
			resolvePromise({ code, signal, stderr: stderr.toString(), timedOut, aborted });
		});
		// stdin remains a recorded Pi user message, without the OS argv length limit.
		proc.stdin.on("error", () => {}); // EPIPE on early exit is reported by close.
		proc.stdin.end(opts.input ?? "");
		if (opts.signal?.aborted) abort();
	});
}

export type ObserverLaunchEnv = {
	/** Absolute `.memory/<sessionId>/` root — IPC files and the consolidator sandbox live here. */
	memoryRoot: string;
	runId: string;
	request?: WorkerRequest;
};

/**
 * Build per-run IPC configuration. The transcript is delivered on stdin as a recorded
 * Pi user message, not in environment variables or an oversized argv argument.
 */
export function buildWorkerEnv(role: "observer" | "consolidator", opts: ObserverLaunchEnv): NodeJS.ProcessEnv {
	const requestPath = join(runsDir(opts.memoryRoot), `${opts.runId}.request.json`);
	if (opts.request) atomicWrite(requestPath, JSON.stringify(opts.request));
	return {
		...process.env,
		OM_REQUEST_PATH: requestPath,
		OM_WORKER: role,
		OM_RUN_ID: opts.runId,
		OM_RESULT_PATH: runResultPath(opts.memoryRoot, opts.runId),
		// Per-run cost handoff: the worker extension writes pi's built-in usage.cost.total here.
		OM_COST_PATH: runCostPath(opts.memoryRoot, opts.runId),
		// Sandbox root for the consolidator's scoped file tools (design risk 6).
		OM_MEMORY_DIR: opts.memoryRoot,
	};
}
