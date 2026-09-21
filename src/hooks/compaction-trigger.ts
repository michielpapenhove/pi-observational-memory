import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { rawTokensSinceLastCompaction, type Entry } from "../ledger/index.js";
import type { Runtime } from "../runtime.js";
import { planCompaction } from "./compaction-hook.js";

/** Pi's retryable-error detection: don't compact between an auto-retried turn's attempts. */
const RETRYABLE_ERROR_RE =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

function contextPressureTokens(
	ctx: { getContextUsage?: () => { tokens: number | null } | undefined; sessionManager: { getBranch: () => Entry[] } },
	threshold: number,
): { tokens: number; due: boolean } {
	const live = ctx.getContextUsage?.()?.tokens;
	if (live != null) return { tokens: live, due: live >= threshold };
	const raw = rawTokensSinceLastCompaction(ctx.sessionManager.getBranch());
	return { tokens: raw, due: raw >= threshold };
}

/** A response pi will retry on its own must not be compacted between attempts. */
function isRetryableError(message: { role?: string; stopReason?: string; errorMessage?: string } | undefined): boolean {
	if (!message || message.role !== "assistant") return false;
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	return RETRYABLE_ERROR_RE.test(message.errorMessage);
}

/**
 * Trigger compaction on `turn_end` once live context usage crosses `compactAtContextTokens`.
 *
 * We fire on `turn_end` (not `agent_end`) so compaction can kick in BETWEEN turns, rather than
 * only once the whole agent run settles. The `session_before_compact` hook still waits for
 * in-flight observers, so the rendered block reflects settled memory state (design R5) — both
 * paths share `planCompaction`, so the wait and the cutoff rules cannot drift apart.
 *
 * Since 0.87 `turn_end` is an actionable boundary: a returned `compaction` draft is persisted in
 * order and the loop's own decision is left alone. That replaces the old `ctx.compact()` path,
 * which disconnected and aborted the agent loop up front and then had to be papered over with a
 * hidden resume message (`pi.sendMessage(..., { triggerTurn: true })`) whenever the hook refused.
 * Two things fall away with it:
 *  - no synthetic user-role message in the model context ("[automatic] Your context was just
 *    compacted…") — the draft adds no message at all;
 *  - no window in which an aborted loop plus a refused compaction could silently strand a
 *    mid-run turn. A refusal here is just "no compaction this turn": pending tool work still
 *    continues and a terminal turn still stops, exactly as if no compaction had been attempted.
 *
 * The run's own continuation is what makes the mid-run case transparent, so `continue` is left
 * unset: `turn_end` with pending tool work already produces the next provider request, and a
 * terminal turn is meant to stop.
 *
 * Only a `completed` turn compacts. An errored response is followed by pi's retry/recovery
 * lifecycle, and an aborted one is the user stopping — both are hard exits that must not have
 * the context rewritten underneath them.
 */
export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("turn_end", (async (event: TurnEndEvent, ctx: ExtensionContext) => {
		if (!runtime.enabled || runtime.config.passive) return;
		if (event.outcome !== "completed") return;
		if (isRetryableError(event.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined)) return;
		const pressure = contextPressureTokens(ctx, runtime.config.compactAtContextTokens);
		if (!pressure.due) return;

		runtime.ensureConfig(ctx.cwd);
		const generation = runtime.generation;
		const branch = ctx.sessionManager.getBranch() as unknown as Entry[];

		// Visible feedback before the commit: the draft is committed after every boundary handler
		// returns, so this line cannot wait to confirm it.
		if (ctx.hasUI)
			ctx.ui.notify(
				`om: context at ${Math.round(pressure.tokens / 1000)}k — folding into a compaction block between turns`,
				"info",
			);

		const plan = await planCompaction(
			runtime,
			{
				hasUI: ctx.hasUI,
				ui: ctx.ui,
				sessionManager: ctx.sessionManager as unknown as { getBranch?: () => Entry[] },
				signal: ctx.signal,
			},
			branch,
			{
				tailTokens: runtime.config.tailTokens,
				maxTailTokens: runtime.config.maxTailTokens,
			},
		);

		// Session replaced (or om switched off) while waiting on observers: the draft would land
		// in a session it was not computed for.
		if (!runtime.isCurrent(generation) || plan.status === "refuse") return;

		return {
			entries: [
				...event.entries,
				{
					type: "compaction" as const,
					summary: plan.summary,
					firstKeptEntryId: plan.firstKeptEntryId,
					details: plan.details,
				},
			],
		};
	}) as never);
}
