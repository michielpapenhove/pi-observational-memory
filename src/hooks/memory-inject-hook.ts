/**
 * Session-start memory intro (before_agent_start).
 *
 * Problem: the memory map (INDEX/topics/JOURNEY) is only rendered into the COMPACTION block.
 * A fresh fork, or any session whose context stays under the compaction threshold, never
 * learns that durable knowledge exists: the seeded `.memory/<sessionId>/` tree sits on disk
 * but the model starts blind and re-derives or re-asks things already recorded.
 *
 * This hook injects ONE persisted message (`om.memory-intro`, visible in the TUI) with the
 * memory map (+ pointer to JOURNEY.md and the topic files) when om is enabled and the session
 * has durable memory. Self-gating:
 *  - runtime.enabled / runtime.memoryRoot (the per-session /om gate);
 *  - process.env.OM_WORKER (observer/consolidator subprocesses never get the intro);
 *  - the `.runs/memory-intro` marker (exactly once per session; survives resume/reload; the
 *    `.runs` tree is excluded from fork seeding, so a fork still receives its own intro even
 *    though it seeded the parent's files).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { renderMemoryMap } from "../memory/index-render.js";
import { atomicWrite, journeyPath, listTopics, readJourney } from "../memory/paths.js";
import type { Runtime } from "../runtime.js";

const INTRO_CUSTOM_TYPE = "om.memory-intro";
const INTRO_MARKER = "memory-intro";

/** Per-session marker inside the transient `.runs/` tree: never seeded to forks, survives reload/resume. */
export function introMarkerPath(memoryRoot: string): string {
	return join(memoryRoot, ".runs", INTRO_MARKER);
}

export function hasIntroMarker(memoryRoot: string): boolean {
	return existsSync(introMarkerPath(memoryRoot));
}

export function markIntroInjected(memoryRoot: string): void {
	atomicWrite(introMarkerPath(memoryRoot), `${new Date().toISOString()}\n`);
}

/**
 * Build the intro message body from the durable memory tree. Returns undefined when there is
 * nothing durable yet (no topics AND no journey) — then we keep the context lean and stay
 * silent. The memory map is rendered inline (cheap, model-free); JOURNEY.md and the topic
 * files themselves are pointers the model reads with its own tools when relevant.
 */
export function buildMemoryIntro(memoryRoot: string): string | undefined {
	const topics = listTopics(memoryRoot);
	const journey = readJourney(memoryRoot);
	const map = renderMemoryMap(topics);
	if (!map && !journey) return undefined; // nothing durable yet; stay invisible
	const intro = ["Observational memory is active for this session."];
	intro.push(
		`Durable knowledge from earlier work in this session (and forks seeded from it) lives under \`.memory/\` at \`${memoryRoot}\`.`,
	);
	if (map) intro.push(map);
	if (journey) {
		intro.push(
			`Descriptive history of how this work reached its current state: \`${journeyPath(memoryRoot)}\` (read it for orientation before starting).`,
		);
	}
	intro.push(
		"Read the relevant topic file(s) and/or JOURNEY.md BEFORE re-deriving or re-explaining known context, and before asking Michiel for information that is already recorded.",
	);
	return intro.join("\n\n");
}

export function registerMemoryInjectHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("before_agent_start", async (_event: unknown, _ctx: unknown) => {
		if (!runtime.enabled || !runtime.memoryRoot) return;
		// Observer/consolidator subprocesses never receive the intro.
		if (process.env.OM_WORKER) return;
		// Exactly once per session; the marker lives in `.runs/`, which fork seeding skips.
		if (hasIntroMarker(runtime.memoryRoot)) return;

		const content = buildMemoryIntro(runtime.memoryRoot);
		if (!content) return; // nothing durable yet; stay invisible

		markIntroInjected(runtime.memoryRoot);
		return {
			message: { customType: INTRO_CUSTOM_TYPE, content, display: true },
		};
	});
}
