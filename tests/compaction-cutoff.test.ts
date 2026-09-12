import { describe, expect, it } from "vitest";

import { buildCompactionProjection, renderSummary } from "../src/ledger/index.js";
import { canSkipObserverWait, decideCompaction, observerStalled, snapCutoff, snapFirstKeptEntryId, type CutoffSnap } from "../src/hooks/compaction-hook.js";
import {
	compactionEntry,
	observation,
	observationsRecordedEntry,
	rawMessage,
	toolResultMessage,
	type TestEntry,
} from "./fixtures/session.js";

// 40 chars ⇒ 10 estimated tokens per source message.
const body = "x".repeat(40);

/**
 * Number of already-written compaction summaries that fall inside the kept region of a cutoff.
 *
 * pi keeps every entry from `firstKeptEntryId` onward, and current pi (0.85+) re-emits a kept
 * compaction entry as a compaction summary message. So a cutoff that lands behind an existing
 * compaction entry folds that summary back into the live context — the incident that stacked 20
 * summaries into 509k tokens. This invariant is deliberately checked against the branch instead
 * of pi's resolver: the pinned dev dependency (0.74.x) predates the inclusion.
 */
function summariesInsideKeptRegion(branch: TestEntry[], firstKeptEntryId: string): number {
	const start = branch.findIndex((entry) => entry.id === firstKeptEntryId);
	return branch.slice(start).filter((entry) => entry.type === "compaction").length;
}

describe("snapFirstKeptEntryId", () => {
	it("snaps to the chunk boundary whose tail is closest to tailTokens", () => {
		const branch = [
			rawMessage("raw-1", body),
			rawMessage("raw-2", body),
			observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:01")], coversUpToId: "raw-2" }),
			rawMessage("raw-3", body),
			rawMessage("raw-4", body),
			observationsRecordedEntry("om-2", { observations: [observation("2026-05-02T10:05:00")], coversUpToId: "raw-4" }),
			rawMessage("raw-5", body),
			rawMessage("raw-6", body),
		];

		// Boundaries: raw-2 (tail 40), raw-4 (tail 20). tailTokens 25 → raw-4 boundary → keep raw-5.
		expect(snapFirstKeptEntryId(branch, "raw-6", 25)).toBe("raw-5");
		// Larger tailTokens favors the earlier boundary.
		expect(snapFirstKeptEntryId(branch, "raw-6", 40)).toBe("raw-3");
	});

	it("skips a boundary whose next entry is not a valid cut point (tool result)", () => {
		const branch = [
			rawMessage("raw-1", body),
			rawMessage("raw-2", body),
			observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:01")], coversUpToId: "raw-2" }),
			toolResultMessage("tr-1", body), // would-be firstKept after raw-2 → invalid
			rawMessage("raw-3", body),
			observationsRecordedEntry("om-2", { observations: [observation("2026-05-02T10:05:00")], coversUpToId: "raw-3" }),
			rawMessage("raw-4", body),
		];

		// raw-2 boundary disqualified (next entry tr-1 is a tool result); raw-3 boundary keeps raw-4.
		expect(snapFirstKeptEntryId(branch, "raw-4", 5)).toBe("raw-4");
	});

	it("falls back to pi's proposed firstKeptEntryId when no boundary qualifies", () => {
		const branch = [rawMessage("raw-1", body), rawMessage("raw-2", body)];
		expect(snapFirstKeptEntryId(branch, "raw-2", 5)).toBe("raw-2");
	});
});

describe("snapCutoff with a lagging observer (bounded tail, no stacked summaries)", () => {
	// Coverage stops at raw-2; c-1 already summarized raw-3..raw-4; the tip has grown to raw-6.
	const lagging = [
		rawMessage("raw-1", body),
		rawMessage("raw-2", body),
		observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:01")], coversUpToId: "raw-2" }),
		rawMessage("raw-3", body),
		rawMessage("raw-4", body),
		compactionEntry("c-1", { firstKeptEntryId: "raw-3" }),
		rawMessage("raw-5", body),
		rawMessage("raw-6", body),
	];

	it("never snaps behind the last compaction; cuts ahead of the observer instead", () => {
		const snap = snapCutoff(lagging, "raw-6", 20, 40);
		expect(snap.kind).toBe("forward");
		expect(snap.firstKeptId).toBe("raw-5"); // earliest cut whose tail stays at the target
		expect(snap.tail).toBe(20);
	});

	it("never lets an earlier summary fall inside the kept region", () => {
		const snap = snapCutoff(lagging, "raw-6", 20, 40);

		// The stale boundary (raw-3) sits behind c-1, so c-1's summary would come back.
		expect(summariesInsideKeptRegion(lagging, "raw-3")).toBe(1);
		// The snapped cutoff lands after c-1, so the old summary stays gone.
		expect(summariesInsideKeptRegion(lagging, snap.firstKeptId)).toBe(0);
	});

	it("stays on a boundary while it is within the maxTailTokens band", () => {
		// Three trailing messages (30 tokens) behind the only boundary; band is 40.
		const branch = [
			rawMessage("raw-1", body),
			rawMessage("raw-2", body),
			observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:01")], coversUpToId: "raw-2" }),
			rawMessage("raw-3", body),
			rawMessage("raw-4", body),
			rawMessage("raw-5", body),
		];
		const snap = snapCutoff(branch, "raw-5", 20, 40);
		expect(snap.kind).toBe("boundary");
		expect(snap.firstKeptId).toBe("raw-3");
		expect(snap.tail).toBe(30);
	});

	it("cuts ahead when the closest boundary is beyond the band", () => {
		const branch = [
			rawMessage("raw-1", body),
			rawMessage("raw-2", body),
			observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:01")], coversUpToId: "raw-2" }),
			rawMessage("raw-3", body),
			rawMessage("raw-4", body),
			rawMessage("raw-5", body),
		];
		// Same branch, tighter band: the 30-token tail is refused, so the cutoff moves to raw-4.
		const snap = snapCutoff(branch, "raw-5", 20, 25);
		expect(snap.kind).toBe("forward");
		expect(snap.firstKeptId).toBe("raw-4");
		expect(snap.tail).toBe(20);
	});

	it("defers when every boundary sits at or behind the last compaction and nothing follows it", () => {
		const branch = [
			rawMessage("raw-1", body),
			rawMessage("raw-2", body),
			observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:01")], coversUpToId: "raw-2" }),
			rawMessage("raw-3", body),
			compactionEntry("c-1", { firstKeptEntryId: "raw-3" }),
		];
		const snap = snapCutoff(branch, "raw-3", 20, 40);
		expect(snap.kind).toBe("none");
		expect(snap.reason).toBe("behind-last-compaction");
		expect(snap.tail).toBeUndefined();
	});

	it("reports the reason when no chunk has been observed at all", () => {
		const snap = snapCutoff([rawMessage("raw-1", body), rawMessage("raw-2", body)], "raw-2", 5, 10);
		expect(snap.kind).toBe("none");
		expect(snap.reason).toBe("no-observation-boundary");
	});

	it("still reports a boundary snap in the caught-up case", () => {
		const branch = [
			rawMessage("raw-1", body),
			rawMessage("raw-2", body),
			observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:01")], coversUpToId: "raw-2" }),
			rawMessage("raw-3", body),
			rawMessage("raw-4", body),
			observationsRecordedEntry("om-2", { observations: [observation("2026-05-02T10:05:00")], coversUpToId: "raw-4" }),
			rawMessage("raw-5", body),
			rawMessage("raw-6", body),
		];
		const snap = snapCutoff(branch, "raw-6", 20, 40);
		expect(snap.kind).toBe("boundary");
		expect(snap.firstKeptId).toBe("raw-5");
		expect(snap.tail).toBe(20);
	});
});

describe("decideCompaction and observerStalled", () => {
	const boundarySnap: CutoffSnap = { firstKeptId: "raw-5", tail: 20, kind: "boundary" };
	const forwardSnap: CutoffSnap = { firstKeptId: "raw-5", tail: 20, kind: "forward" };
	const noneSnap: CutoffSnap = { firstKeptId: "raw-5", tail: undefined, kind: "none", reason: "behind-last-compaction" };

	it("compacts a forward cut while the observer can still catch up", () => {
		expect(decideCompaction(forwardSnap, false)).toEqual({ action: "compact" });
	});

	it("refuses a forward cut once the observer can no longer reach the skipped region", () => {
		expect(decideCompaction(forwardSnap, true)).toEqual({ action: "cancel", reason: "observer-stalled" });
	});

	it("still compacts a boundary snap while the observer is stalled", () => {
		expect(decideCompaction(boundarySnap, true)).toEqual({ action: "compact" });
	});

	it("cancels with the snap's own reason", () => {
		expect(decideCompaction(noneSnap, false)).toEqual({ action: "cancel", reason: "behind-last-compaction" });
	});

	it("counts a blocked or exhausted observer as stalled", () => {
		expect(observerStalled({ observerBlocked: undefined, observerFailures: 0 }, 3)).toBe(false);
		expect(observerStalled({ observerBlocked: undefined, observerFailures: 2 }, 3)).toBe(false);
		expect(observerStalled({ observerBlocked: undefined, observerFailures: 3 }, 3)).toBe(true);
		expect(observerStalled({ observerBlocked: "chunk exceeds maxWorkerPromptBytes", observerFailures: 0 }, 3)).toBe(true);
	});
});

describe("canSkipObserverWait (R5 fast path)", () => {
	// Two committed chunks; cutoff snaps to raw-4 boundary (keep raw-5). Tail after raw-4 = 10.
	const branch = [
		rawMessage("raw-1", body),
		rawMessage("raw-2", body),
		observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:01")], coversUpToId: "raw-2" }),
		rawMessage("raw-3", body),
		rawMessage("raw-4", body),
		observationsRecordedEntry("om-2", { observations: [observation("2026-05-02T10:05:00")], coversUpToId: "raw-4" }),
		rawMessage("raw-5", body),
		rawMessage("raw-6", body),
	];
	const snap = snapCutoff(branch, "raw-6", 20); // firstKeptId raw-5, tail 20 (raw-5 + raw-6)

	it("skips when there are no in-flight observers and the tail is at/under target", () => {
		expect(snap.firstKeptId).toBe("raw-5");
		expect(snap.tail).toBe(20);
		expect(canSkipObserverWait(branch, snap.firstKeptId, snap.tail, 20, [])).toBe(true);
	});

	it("skips when every in-flight observer covers a chunk in the verbatim tail", () => {
		// Observer working raw-6 (after the raw-5 cutoff) → excluded from the projection anyway.
		expect(canSkipObserverWait(branch, snap.firstKeptId, snap.tail, 20, [{ coversUpToId: "raw-6" }])).toBe(true);
	});

	it("waits when an in-flight observer covers a chunk at/before the cutoff", () => {
		// A slow observer still on raw-2 (before the raw-5 cutoff) would enter the projection.
		expect(canSkipObserverWait(branch, snap.firstKeptId, snap.tail, 20, [{ coversUpToId: "raw-2" }])).toBe(false);
	});

	it("waits when the in-flight observer's coversUpToId does not resolve in the branch", () => {
		expect(canSkipObserverWait(branch, snap.firstKeptId, snap.tail, 20, [{ coversUpToId: "ghost" }])).toBe(false);
	});

	it("waits when the snapped tail exceeds tailTokens (snap could still move)", () => {
		// tailTokens 5 < actual tail 10 → a just-committed tail boundary could become a better snap.
		expect(canSkipObserverWait(branch, snap.firstKeptId, snap.tail, 5, [])).toBe(false);
	});

	it("waits when snap fell back to pi's proposal (no qualifying boundary)", () => {
		const bare = [rawMessage("raw-1", body), rawMessage("raw-2", body)];
		const fallback = snapCutoff(bare, "raw-2", 5);
		expect(fallback.tail).toBeUndefined();
		expect(canSkipObserverWait(bare, fallback.firstKeptId, fallback.tail, 5, [])).toBe(false);
	});
});

describe("cutoff ↔ projection integration (no double representation)", () => {
	it("renders exactly the observations whose source precedes the snapped cutoff", () => {
		const branch = [
			rawMessage("raw-1", body),
			rawMessage("raw-2", body),
			observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:01", { content: "early" })], coversUpToId: "raw-2" }),
			rawMessage("raw-3", body),
			rawMessage("raw-4", body),
			observationsRecordedEntry("om-2", { observations: [observation("2026-05-02T10:05:00", { content: "late" })], coversUpToId: "raw-4" }),
			rawMessage("raw-5", body),
		];

		const snapped = snapFirstKeptEntryId(branch, "raw-5", 10); // tail after raw-4 = 10 → keep raw-5
		expect(snapped).toBe("raw-5");

		const projection = buildCompactionProjection(branch, snapped);
		// Both chunks precede the cutoff (raw-5); both render, nothing in the verbatim tail.
		expect(projection.observations.map((o) => o.content)).toEqual(["early", "late"]);

		const summary = renderSummary(undefined, undefined, projection.observations);
		expect(summary).toContain("2026-05-02T10:00:01  early");
		expect(summary).toContain("2026-05-02T10:05:00  late");
	});
});
