import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderMemoryMap } from "../memory/index-render.js";
import { listTopics, readJourney } from "../memory/paths.js";
import type { Runtime } from "../runtime.js";
import { estimateEntryTokens } from "../tokens.js";
import {
	buildCompactionProjection,
	entryIndexById,
	findLastCompactionIndex,
	isObservationsRecordedEntry,
	isSourceEntry,
	isValidCutPoint,
	rawTokensAfterIndex,
	renderSummary,
	type Entry,
} from "../ledger/index.js";

/** Distinct, branch-resolved coversUpToId indices of committed observation chunks, ascending. */
function chunkBoundaryIndices(branch: Entry[], indexes: Map<string, number>): number[] {
	const set = new Set<number>();
	for (const entry of branch) {
		if (!isObservationsRecordedEntry(entry)) continue;
		const idx = indexes.get(entry.data.coversUpToId);
		if (idx !== undefined) set.add(idx);
	}
	return Array.from(set).sort((a, b) => a - b);
}

/** First source entry after `boundaryIndex` that is a valid cut point, or undefined. */
function firstKeptAfterBoundary(branch: Entry[], boundaryIndex: number): Entry | undefined {
	for (let i = boundaryIndex + 1; i < branch.length; i++) {
		if (!isSourceEntry(branch[i])) continue;
		return isValidCutPoint(branch[i]) ? branch[i] : undefined;
	}
	return undefined;
}

export type CutoffKind = "boundary" | "forward" | "none";

export type CutoffSnap = {
	/** Entry the verbatim tail starts at. */
	firstKeptId: string;
	/** Raw source tokens retained verbatim after the cutoff; undefined when nothing qualified. */
	tail: number | undefined;
	/**
	 * "boundary": the cutoff sits on a confirmed observation chunk boundary (the normal case).
	 * "forward": the cutoff sits ahead of the observer's watermark, keeping the tail bounded.
	 * "none": no usable cutoff (see `reason`); the caller must cancel the compaction.
	 */
	kind: CutoffKind;
	/** Why no cutoff qualified. Only set when `kind` is "none". */
	reason?: "no-observation-boundary" | "behind-last-compaction";
};

/** Estimated raw source tokens from `startIndex` (inclusive) to the tip. */
function rawTokensFromIndex(branch: Entry[], startIndex: number): number {
	let total = 0;
	for (let i = Math.max(0, startIndex); i < branch.length; i++) {
		if (isSourceEntry(branch[i])) total += estimateEntryTokens(branch[i]);
	}
	return total;
}

/**
 * Earliest valid cut point at or after `startIndex` whose verbatim tail is at most `tailTokens`.
 *
 * Used when the observer has committed no chunk boundary close enough to the tip: pi keeps
 * everything from `firstKeptEntryId` onward, so a boundary far behind the tip would retain a
 * huge verbatim tail (and, when it sits behind an existing compaction entry, fold that summary
 * back into the live context). Cutting ahead of the observer keeps the tail at its designed
 * size. Source entries skipped this way are not lost: the observer reads the branch, not the
 * context, so its observations still arrive and are folded into a later summary.
 */
function forwardCut(branch: Entry[], startIndex: number, tailTokens: number): { firstKeptId: string; tail: number } | undefined {
	let tail = rawTokensFromIndex(branch, startIndex);
	for (let i = Math.max(0, startIndex); i < branch.length; i++) {
		const entry = branch[i];
		if (!isSourceEntry(entry)) continue;
		if (isValidCutPoint(entry) && tail <= tailTokens) return { firstKeptId: entry.id, tail };
		tail -= estimateEntryTokens(entry);
	}
	return undefined;
}

/**
 * Snap pi's proposed `firstKeptEntryId` to an observation chunk boundary so the verbatim tail
 * starts exactly where a chunk ends — no chunk straddles the cutoff, so nothing is both
 * rendered into the summary and kept verbatim (and nothing is lost). Among boundaries whose
 * next entry is a valid cut point and that land *after* the last compaction, pick the one whose
 * resulting tail is closest to `tailTokens`.
 *
 * Two rules keep compaction from growing the window instead of shrinking it:
 *  - A cutoff at or before the last compaction entry would fold that summary back into the live
 *    context (pi keeps everything from `firstKeptEntryId` onward), so those boundaries are
 *    never eligible.
 *  - When the best eligible boundary still leaves more than `maxTailTokens` verbatim — i.e. the
 *    observer is lagging behind the tip — the cutoff moves ahead of the observer to
 *    `tailTokens` instead (see {@link forwardCut}). When even that is impossible the compaction
 *    is refused rather than performed without shrinking anything.
 *
 * Falls back to pi's proposal with `kind: "none"` when no cutoff qualifies.
 */
export function snapCutoff(
	branch: Entry[],
	proposedFirstKeptId: string,
	tailTokens: number,
	maxTailTokens: number = tailTokens * 2,
): CutoffSnap {
	const indexes = entryIndexById(branch);
	const boundaries = chunkBoundaryIndices(branch, indexes);
	// Without a single committed chunk there is nothing to render and nothing to summarize.
	if (boundaries.length === 0) {
		return { firstKeptId: proposedFirstKeptId, tail: undefined, kind: "none", reason: "no-observation-boundary" };
	}

	const lastCompactionIndex = findLastCompactionIndex(branch);
	let bestId: string | undefined;
	let bestTail: number | undefined;
	let bestDelta = Number.POSITIVE_INFINITY;

	for (const boundaryIndex of boundaries) {
		const firstKept = firstKeptAfterBoundary(branch, boundaryIndex);
		if (!firstKept) continue;
		const firstKeptIndex = indexes.get(firstKept.id);
		if (firstKeptIndex === undefined || firstKeptIndex <= lastCompactionIndex) continue;
		const tail = rawTokensAfterIndex(branch, boundaryIndex);
		const delta = Math.abs(tail - tailTokens);
		if (delta < bestDelta) {
			bestDelta = delta;
			bestId = firstKept.id;
			bestTail = tail;
		}
	}

	if (bestId !== undefined && bestTail !== undefined && bestTail <= maxTailTokens) {
		return { firstKeptId: bestId, tail: bestTail, kind: "boundary" };
	}

	const forward = forwardCut(branch, lastCompactionIndex + 1, tailTokens);
	if (forward) return { firstKeptId: forward.firstKeptId, tail: forward.tail, kind: "forward" };

	return { firstKeptId: proposedFirstKeptId, tail: undefined, kind: "none", reason: "behind-last-compaction" };
}

export function snapFirstKeptEntryId(
	branch: Entry[],
	proposedFirstKeptId: string,
	tailTokens: number,
	maxTailTokens?: number,
): string {
	return snapCutoff(branch, proposedFirstKeptId, tailTokens, maxTailTokens).firstKeptId;
}

/**
 * A forward cut is only justified while the observer can still reach the skipped region later:
 * its observations are what folds that history into a summary eventually. Once the observer is
 * permanently stalled (an oversized chunk blocks the watermark, or retries are exhausted), the
 * skip would silently drop never-observed history from the live context, so refuse instead.
 */
export function observerStalled(
	runtime: Pick<Runtime, "observerBlocked" | "observerFailures">,
	maxWorkerAttempts: number,
): boolean {
	return runtime.observerBlocked !== undefined || runtime.observerFailures >= maxWorkerAttempts;
}

/** Why a compaction was refused. */
export type CancelReason = "no-observation-boundary" | "behind-last-compaction" | "observer-stalled";

export type CompactionDecision = { action: "compact" } | { action: "cancel"; reason: CancelReason };

const CANCEL_NOTICES: Record<CancelReason, string> = {
	"no-observation-boundary": "om: no confirmed observer boundary; compaction cancelled to retain raw history",
	"behind-last-compaction": "om: observer is behind the last compaction; compaction deferred (raw history retained)",
	"observer-stalled":
		"om: observer is stopped — refusing to compact ahead of it so unobserved history stays intact (see /om:status)",
};

/** Turn a snap into the hook's decision, including the refusals that outrank a forward cut. */
export function decideCompaction(snap: CutoffSnap, observerIsStalled: boolean): CompactionDecision {
	if (snap.kind === "none") return { action: "cancel", reason: snap.reason ?? "no-observation-boundary" };
	if (snap.kind === "forward" && observerIsStalled) return { action: "cancel", reason: "observer-stalled" };
	return { action: "compact" };
}

/**
 * Fast-path test: can compaction skip waiting for in-flight observers entirely?
 *
 * Only meaningful for a **boundary** snap (`kind: "boundary"`). A forward cut must always wait:
 * committing a tail-region boundary can replace it with a fully observed cutoff, which is strictly
 * better than cutting ahead of the observer.
 *
 * The wait exists so just-committed observations are folded before rendering. But an observer
 * only affects the rendered block if its chunk's `coversUpToId` lands at-or-before the cutoff
 * (the projection includes an `om.observations.recorded` entry iff its coverage index is
 * `< index(firstKeptId)` — see `buildCompactionProjection`'s `beforeEntry` boundary). Observers
 * working a chunk in the verbatim tail are excluded regardless, so waiting for them is dead time.
 *
 * Two conditions must hold for a truly no-op skip (identical block AND identical cutoff):
 *  1. No in-flight observer has `coversUpToId` strictly before the cutoff entry (none can enter
 *     the projection). Unresolved ids are treated conservatively as "before" → wait.
 *  2. The snapped cutoff's tail is already `<= tailTokens`. Then committing the (tail-region)
 *     skipped observers can only produce SMALLER tails (further from target), so the snap is
 *     provably stable. If the tail is `> tailTokens` (nothing committed near the tip), a
 *     just-committed tail boundary could become a better snap target — so we wait, which also
 *     yields a tighter tail.
 */
export function canSkipObserverWait(
	branch: Entry[],
	snappedFirstKeptId: string,
	snappedTail: number | undefined,
	tailTokens: number,
	observersInFlight: Iterable<{ coversUpToId: string }>,
): boolean {
	// Condition 2: snap is only stable under skipped observers when its tail is already <= target.
	if (snappedTail === undefined || snappedTail > tailTokens) return false;

	const indexes = entryIndexById(branch);
	const cutoffIndex = indexes.get(snappedFirstKeptId);
	if (cutoffIndex === undefined) return false; // can't reason about the boundary → wait

	// Condition 1: every in-flight observer must cover a chunk that ends at-or-after the cutoff.
	for (const { coversUpToId } of observersInFlight) {
		const idx = indexes.get(coversUpToId);
		if (idx === undefined || idx < cutoffIndex) return false;
	}
	return true;
}

/** What a compaction would do, decided before either caller commits anything. */
export type CompactionPlan =
	| { status: "compact"; kind: Exclude<CutoffKind, "none">; firstKeptEntryId: string; summary: string; details: unknown }
	| { status: "refuse"; reason: CancelReason | "aborted" };

/** The context surface a plan needs, so both entry points can share `planCompaction`. */
export type PlanContext = {
	hasUI?: boolean;
	ui?: { notify?: (message: string, level?: any) => void };
	sessionManager?: { getBranch?: () => Entry[] };
	/** This compaction's abort signal: the hook takes `event.signal`, the boundary `ctx.signal`. */
	signal?: AbortSignal;
};

export type PlanOptions = {
	/**
	 * pi's proposed kept tail (`session_before_compact` only). A `turn_end` boundary has no such
	 * proposal: it either finds a real observation cutoff or refuses. A refusal never reads it.
	 */
	proposedFirstKeptId?: string;
	tailTokens: number;
	maxTailTokens: number;
};

/**
 * Decide and render one compaction. One implementation, two callers:
 *  - `session_before_compact` — pi's own paths: `/compact`, pi's between-turn threshold, and
 *    overflow recovery. The hook turns the plan into its `{ compaction }` decision.
 *  - the `turn_end` boundary — om's own `compactAtContextTokens`, committed as a boundary draft
 *    entry. Committing there never aborts the agent loop, so a refusal just means "not this
 *    turn" and the run continues (or stops) on its own.
 *
 * The R5 observer wait lives here so both callers share it (design R5): a boundary snap whose
 * tail is already at target and that no in-flight observer can enter the rendered block skips
 * the wait; every other case waits, then re-reads the branch so just-committed observations are
 * folded into the block.
 */
export async function planCompaction(
	runtime: Runtime,
	ctx: PlanContext,
	branch: Entry[],
	options: PlanOptions,
): Promise<CompactionPlan> {
	const { tailTokens, maxTailTokens } = options;
	const notify = (message: string, level: string) => {
		if (ctx.hasUI) ctx.ui?.notify?.(message, level);
	};
	// Placeholder only: the snap returns it with `kind: "none"`, which refuses below.
	const proposed = options.proposedFirstKeptId ?? branch.at(-1)?.id ?? "";

	let settled = branch;
	let snap = snapCutoff(settled, proposed, tailTokens, maxTailTokens);

	const skip =
		snap.kind === "boundary" &&
		canSkipObserverWait(settled, snap.firstKeptId, snap.tail, tailTokens, runtime.observersInFlight.values());
	runtime.lastCompactionObserverWait = skip ? "skipped" : "waited";
	if (!skip) {
		if (ctx.hasUI && runtime.observersInFlight.size > 0)
			notify("om: waiting for in-flight observers before folding…", "info");
		await runtime.whenObserversIdle();
		settled = (ctx.sessionManager?.getBranch?.() as Entry[] | undefined) ?? settled;
		snap = snapCutoff(settled, proposed, tailTokens, maxTailTokens);
	}

	if (ctx.signal?.aborted) return { status: "refuse", reason: "aborted" };
	const decision = decideCompaction(snap, observerStalled(runtime, runtime.config.maxWorkerAttempts));
	if (decision.action === "cancel") {
		notify(CANCEL_NOTICES[decision.reason], "warning");
		return { status: "refuse", reason: decision.reason };
	}
	// `decideCompaction` only lets boundary/forward snaps through; narrow for the plan's type.
	if (snap.kind === "none") return { status: "refuse", reason: snap.reason ?? "no-observation-boundary" };
	if (snap.kind === "forward")
		notify(
			`om: observer is behind — cutting ahead of it so the verbatim tail stays near ${Math.round(tailTokens / 1000)}k tokens`,
			"info",
		);

	// Phase B: render the long-term tier live from disk, regenerated each compaction (throwaway
	// projections — cannot decay). The journey is the running descriptive history the consolidator
	// maintains; the map is the topic-file index.
	const projection = buildCompactionProjection(settled, snap.firstKeptId);
	const journey = readJourney(runtime.memoryRoot);
	const map = renderMemoryMap(listTopics(runtime.memoryRoot));

	return {
		status: "compact",
		kind: snap.kind,
		firstKeptEntryId: snap.firstKeptId,
		summary: renderSummary(journey, map, projection.observations),
		details: projection.details,
	};
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event: any, ctx: any) => {
		if (!runtime.enabled || runtime.config.passive) return undefined;

		if (runtime.compactHookInFlight) {
			if (ctx.hasUI) ctx.ui.notify("om: another compaction is already in progress; cancelling duplicate", "warning");
			return { cancel: true };
		}

		const generation = runtime.generation;
		runtime.compactHookInFlight = true;
		try {
			runtime.ensureConfig(ctx.cwd);
			// pi's `event.branchEntries` is stale after any observer wait, so the plan re-reads the
			// branch itself; this read is only the starting point (and the fallback).
			const branch = (ctx.sessionManager?.getBranch?.() as Entry[] | undefined) ?? (event.branchEntries as Entry[]);
			const plan = await planCompaction(
				runtime,
				{
					hasUI: ctx.hasUI,
					ui: ctx.ui,
					sessionManager: ctx.sessionManager,
					signal: event.signal ?? ctx.signal,
				},
				branch,
				{
					proposedFirstKeptId: event.preparation.firstKeptEntryId,
					tailTokens: runtime.config.tailTokens,
					maxTailTokens: runtime.config.maxTailTokens,
				},
			);

			if (!runtime.isCurrent(generation) || plan.status === "refuse") return { cancel: true };
			return {
				compaction: {
					summary: plan.summary,
					firstKeptEntryId: plan.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: plan.details,
				},
			};
		} finally {
			if (runtime.generation === generation) runtime.compactHookInFlight = false;
		}
	});
}
