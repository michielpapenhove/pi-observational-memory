import { type Config, DEFAULTS, loadConfig } from "./config.js";
import { foldLedger, poolTokens, rawTokensSinceObservationCoverage, sumSessionCost, type Entry } from "./ledger/index.js";
import { StatusController } from "./ui/status-controller.js";
import { readActivity } from "./spawn/activity.js";
import { debugLog, withDebugLogContext } from "./debug-log.js";
import { basename } from "node:path";

/**
 * Session-scoped orchestrator state. Triggers run on turns; timers only supervise
 * workers and display activity. Late callbacks are fenced by generation.
 */
export class Runtime {
	config: Config = { ...DEFAULTS };
	configLoaded = false;

	/** The per-session on/off gate (default OFF). Outermost guard in every handler. */
	enabled = false;

	/**
	 * Absolute `.memory/<sessionId>/` root for this session's durable + transient memory. Set
	 * whenever the gate is enabled (session_start / `/om on`) via `ensureSessionMemory`; empty
	 * until first enabled, retained on off while old workers finish. All path helpers (listTopics/indexPath/readJourney/run*Path) take this root.
	 */
	memoryRoot = "";

	/**
	 * In-flight observer subprocesses, keyed by runId. `coversUpToId` is the source-entry id at
	 * the END of the observer's chunk — it lets compaction decide whether the observer can affect
	 * the rendered block (an observer whose chunk lands entirely in the verbatim tail is excluded
	 * from the projection regardless, so compaction need not wait for it).
	 */
	readonly observersInFlight = new Map<string, { controller: AbortController; coversUpToId: string }>();

	/** In-flight observer async tasks, so compaction can wait for settled memory state (design R5). */
	readonly observerTasks = new Set<Promise<void>>();

	/**
	 * Strictly one consolidator at a time (design risk 4). The flag is held from dispatch through
	 * tombstone-commit so the pool clock cannot fire a second overlapping run. Runs in the
	 * background — compaction does NOT wait for it (R5).
	 */
	consolidatorInFlight = false;
	consolidatorController: AbortController | undefined;

	/** Invalidated on off, navigation, reload and session replacement; normal turns don't change it. */
	generation = 0;
	observerBlocked: string | undefined;
	consolidatorBlocked: string | undefined;
	observerFailures = 0;
	observerRetryAt = 0;
	consolidatorFailures = 0;
	consolidatorRetryAt = 0;

	isCurrent(generation: number): boolean { return this.enabled && this.generation === generation; }

	/**
	 * `/om:compact` in-progress guard. The threshold trigger no longer needs it: a boundary draft is
	 * built and committed within the turn, so there is no window to re-enter. The hook keeps its own
	 * `compactHookInFlight` guard against duplicate pi compactions.
	 */
	compactInFlight = false;
	compactHookInFlight = false;

	/** Last worker error message, surfaced by /om:status. */
	lastWorkerError: string | undefined;

	/**
	 * Whether the last compaction waited for in-flight observers or skipped the wait (fast path:
	 * no in-flight observer could affect the rendered block). Surfaced by /om:status.
	 */
	lastCompactionObserverWait: "skipped" | "waited" | undefined;

	readonly status = new StatusController();

	trace(runId: string, event: string, data: Record<string, unknown> = {}): void {
		withDebugLogContext({ enabled: this.config.debugLog, sessionId: basename(this.memoryRoot), runId }, () => debugLog(event,data));
	}

	monitorWorker(runId: string, root: string): () => void {
		const generation = this.generation;
		const timer = setInterval(() => {
			if (!this.isCurrent(generation)) return;
			const activity = readActivity(root,runId);
			if (activity) this.status.workerActivity(runId,activity);
		}, 1000);
		timer.unref?.();
		return () => clearInterval(timer);
	}

	ensureConfig(cwd: string): void {
		if (this.configLoaded) return;
		this.config = loadConfig(cwd);
		this.configLoaded = true;
	}

	/** Recompute the live footer gauges (next-observer + pool + context) from the current branch. */
	refreshFooterGauges(branch: Entry[], contextTokens?: number | null): void {
		if (!this.enabled) return;
		const folded = foldLedger(branch);
		this.status.setGauges({
			nextValue: rawTokensSinceObservationCoverage(branch),
			nextMax: this.config.chunkTokens,
			poolValue: poolTokens(folded.activeObservations),
			poolMax: this.config.consolidateAtPoolTokens,
			ctxValue: contextTokens ?? 0,
			ctxMax: this.config.compactAtContextTokens,
		});
	}

	/**
	 * Recompute accumulated session cost for the footer from ALL entries (every branch), so the
	 * displayed spend never rolls back under /tree. Pass `getEntries()`, not `getBranch()`.
	 */
	refreshCost(allEntries: Entry[]): void {
		if (!this.enabled) return;
		const { costUsd, runs } = sumSessionCost(allEntries);
		this.status.setCost(costUsd, runs);
	}

	/** Invalidate callbacks and abort workers; retain occupied slots until close. */
	abortAllWorkers(): void {
		this.generation++;
		this.observerBlocked = this.consolidatorBlocked = undefined;
		this.observerFailures = this.consolidatorFailures = 0;
		this.observerRetryAt = this.consolidatorRetryAt = 0;
		this.compactInFlight = this.compactHookInFlight = false;
		for (const { controller } of this.observersInFlight.values()) {
			controller.abort();
		}
		// Keep slots occupied until close: off/on must not overlap an old writer with a new one.
		this.consolidatorController?.abort();
	}

	/** Track an observer task for the lifetime of its async run. */
	trackObserverTask(task: Promise<void>): void {
		this.observerTasks.add(task);
		const settled = () => { this.observerTasks.delete(task); };
		void task.then(settled, settled);
	}

	/** Resolve once no observer tasks are in flight (compaction blocks on this). */
	async whenObserversIdle(): Promise<void> {
		while (this.observerTasks.size > 0) {
			await Promise.allSettled([...this.observerTasks]);
		}
	}

	get observerSlotsAvailable(): number {
		return Math.max(0, 1 - this.observersInFlight.size);
	}
}
