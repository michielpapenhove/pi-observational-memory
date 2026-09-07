import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { type RawObservation } from "../../src/spawn/runs.js";

export const OBSERVATION_TIMESTAMP_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$";

const RecordObservationsSchema = Type.Object({
	complete: Type.Optional(Type.Boolean({ description: "Set true on the FINAL call only, when the entire chunk has been covered. Required even with zero observations." })),
	observations: Type.Array(
		Type.Object({
			timestamp: Type.String({
				pattern: OBSERVATION_TIMESTAMP_PATTERN,
				description: "Observation time in local 'YYYY-MM-DD HH:MM' format.",
			}),
			content: Type.String({
				minLength: 1,
				description: "Single-line plain prose. No markdown, no tags, no embedded timestamp.",
			}),
		}),
		{ description: "Batch of new observations. Call multiple times until the chunk is fully covered." },
	),
});

export type RecordObservationsInput = Static<typeof RecordObservationsSchema>;

/**
 * Accumulate observations in-process. Explicit finalization exposes a candidate result;
 * agent/index.ts writes the actual receipt only after a clean agent_end.
 */
export function registerObserverTool(pi: ExtensionAPI) {
	const accumulated: RawObservation[] = [];
	const seen = new Set<string>();
	let complete = false;

	pi.registerTool({
		name: "record_observations",
		label: "Record observations",
		description:
			"Record a batch of observations distilled from the conversation chunk. " +
			"Call multiple times as you work through the chunk; set complete:true on the final call, " +
			"then emit a short plain-text confirmation to end the run.",
		parameters: RecordObservationsSchema,
		async execute(_id: string, params: RecordObservationsInput, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: ExtensionContext) {
			if (complete) throw new Error("observer already completed");
			let added = 0;
			let duplicates = 0;
			for (const obs of params.observations) {
				const content = obs.content.replace(/[\r\n]+/g, " ").trim();
				if (!content) throw new Error("blank observation");
				const key = `${obs.timestamp}␞${content}`;
				if (seen.has(key)) {
					duplicates++;
					continue;
				}
				seen.add(key);
				accumulated.push({ timestamp: obs.timestamp, content });
				added++;
			}
			complete = params.complete === true;
			const dupPart = duplicates > 0 ? ` (${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped)` : "";
			return {
				content: [
					{
						type: "text" as const,
						text: `Recorded ${added} observation${added === 1 ? "" : "s"}${dupPart}. Total so far: ${accumulated.length}. If coverage is complete, your final call MUST set complete:true. Then stop and emit a short confirmation.`,
					},
				],
				details: { added, duplicates, total: accumulated.length },
			};
		},
	});
	return { result: () => complete ? { observations: accumulated } : undefined };
}
