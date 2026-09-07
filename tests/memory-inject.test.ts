import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildMemoryIntro,
	hasIntroMarker,
	introMarkerPath,
	markIntroInjected,
} from "../src/hooks/memory-inject-hook.js";

let cwd: string;
let root: string; // the per-session memory root: <cwd>/.memory/<sessionId>

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "om-intro-"));
	root = join(cwd, ".memory", "sess-1");
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function writeTopic(filename: string, content: string): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, filename), content, "utf-8");
}

describe("buildMemoryIntro", () => {
	it("returns undefined when there is no durable memory yet", () => {
		expect(buildMemoryIntro(root)).toBeUndefined();
	});

	it("renders the memory map for existing topics", () => {
		writeTopic(
			"demo.md",
			"---\nid: demo\ntitle: Demo topic\nsummary: A short summary\nupdated: 2026-09-04\n---\n\nBody.\n",
		);
		const intro = buildMemoryIntro(root);
		expect(intro).toBeDefined();
		expect(intro).toContain("Observational memory is active for this session.");
		expect(intro).toContain("## Memory map");
		expect(intro).toContain(".memory/sess-1/demo.md");
		expect(intro).toContain("A short summary");
	});

	it("points at JOURNEY.md when it exists", () => {
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "JOURNEY.md"), "## Journey\n\nSome history.\n", "utf-8");
		const intro = buildMemoryIntro(root);
		expect(intro).toBeDefined();
		expect(intro).toContain("JOURNEY.md");
		expect(intro).toContain("read it for orientation before starting");
	});

	it("combines topics and journey and reminds to read before re-deriving", () => {
		writeTopic(
			"demo.md",
			"---\nid: demo\ntitle: Demo topic\nsummary: A short summary\n---\n\nBody.\n",
		);
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "JOURNEY.md"), "## Journey\n\nSome history.\n", "utf-8");
		const intro = buildMemoryIntro(root);
		expect(intro).toContain("## Memory map");
		expect(intro).toContain("JOURNEY.md");
		expect(intro).toContain("BEFORE re-deriving or re-explaining known context");
	});
});

describe("intro marker", () => {
	it("is false for an empty or missing session root", () => {
		expect(hasIntroMarker(root)).toBe(false);
		expect(hasIntroMarker(join(cwd, "does-not-exist"))).toBe(false);
	});

	it("lives inside the transient .runs/ tree, which fork seeding skips", () => {
		expect(introMarkerPath(root)).toBe(join(root, ".runs", "memory-intro"));
	});

	it("becomes true after markIntroInjected", () => {
		markIntroInjected(root);
		expect(hasIntroMarker(root)).toBe(true);
	});

	it("does not travel via seeding copy when only the tree is copied", () => {
		markIntroInjected(root);
		const forkRoot = join(cwd, ".memory", "sess-2");
		// Replicate the seeding filter from session.ts: skip anything inside `.runs/`.
		const isRunsPath = (p: string): boolean =>
			p.endsWith(`${sep}.runs`) || p.includes(`${sep}.runs${sep}`);
		cpSync(root, forkRoot, { recursive: true, filter: (src) => !isRunsPath(src) });
		expect(hasIntroMarker(root)).toBe(true);
		expect(hasIntroMarker(forkRoot)).toBe(false);
	});
});
