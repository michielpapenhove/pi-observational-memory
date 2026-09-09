import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { atomicWrite, resolveWithinMemory } from '../../src/memory/paths.js';
import { validateDispositions, type Disposition, type WorkerRequest } from '../../src/spawn/receipt.js';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_EDIT_CORRECTIONS = 3;
/** Only an exact-match rejection before mutation is safe to recover here. */
class EditMatchError extends Error {
 constructor(readonly path: string, message: string) { super(message); }
}
const pathSchema = Type.String({ description: "Bare filename in this session's memory root, e.g. auth.md. No directories or .memory/ prefix." });
const text = (value: string, isError = false) => ({ content: [{ type: 'text' as const, text: value }], details: {}, isError });

/** A flat sandbox matching listTopics. All file operations are synchronous: no RMW await gap. */
export function registerConsolidatorTools(pi: ExtensionAPI, memoryRoot: string, request?: WorkerRequest) {
 const root = resolve(memoryRoot);
 let failed = false;
 let fatalError: string | undefined;
 let correctionAttempts = 0;
 let editCorrectionAttempts = 0;
 const recoverableErrors = new Set<string>();
 let completed: Disposition[] | undefined;
 /** Three edit mismatches and three confirmation rejections, counted independently. */
 const claimCorrection = (name: 'edit' | 'complete_consolidation'): boolean => {
  if (failed || completed) return false;
  if (name === 'edit') {
   if (editCorrectionAttempts >= MAX_EDIT_CORRECTIONS) return false;
   editCorrectionAttempts++;
   return true;
  }
  if (correctionAttempts >= 3) return false;
  correctionAttempts++;
  return true;
 };
 const pathFor = (path: string) => {
  const absolute = resolveWithinMemory(root, path);
  if (!absolute) throw new Error('path escapes .memory/ or is not a bare topic filename (symlinks forbidden)');
  return absolute;
 };
 const read = (path: string) => {
  const absolute = pathFor(path);
  if (statSync(absolute).size > MAX_FILE_BYTES) throw new Error('memory file exceeds 512 KiB; split it before retrying');
  return readFileSync(absolute, 'utf8');
 };
 const register = (name: string, description: string, parameters: any, run: (p: any) => string) => {
  pi.registerTool({ name, label: name, description, parameters, async execute(_id, p) {
   try {
    if (failed) throw new Error('this run had tool errors; keep observations and retry the run');
    return text(run(p));
   } catch (error) {
    if (name === 'edit' && error instanceof EditMatchError && claimCorrection('edit')) {
     recoverableErrors.add(_id);
     throw new Error(`${error.message} in ${error.path}. No file changes. Read ${error.path} again and copy an exact unique substring from the current contents before retrying. Edit correction ${editCorrectionAttempts}/${MAX_EDIT_CORRECTIONS}; another mismatch after this budget stops the run.`);
    }
    // A rejected candidate ACK changed no files and committed no coverage. Let the model repair it.
    if (name === 'complete_consolidation' && claimCorrection('complete_consolidation')) {
     recoverableErrors.add(_id);
     throw error;
    }
    failed = true;
    completed = undefined;
    const cause = error instanceof Error ? error.message : String(error);
    fatalError = name === 'complete_consolidation'
     ? `confirmation failed; correction limit reached or run already failed: ${cause}`
     : `${name} failed: ${error instanceof EditMatchError ? 'edit correction limit reached: ' : ''}${cause}`;
    throw new Error(fatalError);
   }
  } });
 };
 const writable = (path: string) => {
  if (completed) throw new Error('completion already submitted; further mutations forbidden');
  if (path.toUpperCase() === 'INDEX.MD') throw new Error('INDEX.md is generated automatically; do not write it');
  if (path === '.') throw new Error('expected a filename');
  return pathFor(path);
 };
 const write = (path: string, content: string) => {
  const absolute = writable(path);
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('memory file exceeds 512 KiB');
  atomicWrite(absolute, content);
 };
 register('read', 'Read a memory file. Paths are bare filenames.', Type.Object({ path: pathSchema }), p => read(p.path));
 register('write', 'Atomically write a memory file. Preserve existing facts. Never write INDEX.md.', Type.Object({ path: pathSchema, content: Type.String() }), p => {
  write(p.path, p.content); return `Wrote ${p.path} (${Buffer.byteLength(p.content)} bytes).`;
 });
 register('edit', 'Replace one exact unique substring, atomically. On a missing or ambiguous match, read the file again and retry with exact current text; at most three correction opportunities per run.', Type.Object({ path: pathSchema, oldText: Type.String({ minLength: 1 }), newText: Type.String() }), p => {
  writable(p.path);
  if (!p.oldText) throw new Error('oldText must not be empty');
  const before = read(p.path), count = before.split(p.oldText).length - 1;
  if (count !== 1) throw new EditMatchError(p.path, count ? 'oldText is ambiguous' : 'oldText not found');
  // Literal splice: replacement text must not interpret $&, $`, $\' as replace tokens.
  const index = before.indexOf(p.oldText);
  write(p.path, before.slice(0,index) + p.newText + before.slice(index + p.oldText.length));
  return `Edited ${p.path}.`;
 });
 const filenames = () => {
  pathFor('.');
  return existsSync(root) ? readdirSync(root).filter(n => n !== '.' && resolveWithinMemory(root,n)).sort() : [];
 };
 register('ls', 'List flat memory files. Only path "." is supported.', Type.Object({ path: Type.Optional(Type.String()) }), p => {
  if (p.path && p.path !== '.') throw new Error('memory has no subdirectories');
  return filenames().join('\n') || '(empty)';
 });
 register('grep', 'Literal text search in memory files (not a regular expression).', Type.Object({ pattern: Type.String({ minLength: 1 }), path: Type.Optional(pathSchema) }), p => {
  const files = p.path && p.path !== '.' ? [p.path] : filenames();
  const hits: string[] = [];
  for (const name of files) {
   for (const [index,line] of read(name).split('\n').entries()) {
    if (line.includes(p.pattern)) hits.push(`${name}:${index+1}: ${line.slice(0,500)}`);
    if (hits.length >= 100) return hits.join('\n') + '\n[limited to 100 hits]';
   }
  }
  return hits.join('\n') || '(no matches)';
 });
 if (request) register('complete_consolidation', 'Account for EVERY incoming observation with its topic path or an explicit discard reason. If rejected, resubmit the FULL corrected array using the listed missing/unknown/duplicate IDs. After acceptance, stop.', Type.Object({
  dispositions: Type.Array(Type.Object({ timestamp: Type.String(), path: Type.Optional(pathSchema), reason: Type.Optional(Type.String()) }))
 }), p => {
  if (failed) throw new Error('this run had tool errors; keep observations and retry the run');
  completed = validateDispositions(root, request.ids, p.dispositions);
  return 'Completion recorded. Make no more tool calls. Reply with a one-sentence confirmation.';
 });
 /**
  * pi rejects schema-invalid arguments before execute() runs, so those never reach the budgets
  * above. Charge them to the same budget so a malformed call is correctable like a mismatch, and
  * record why the run dies when no budget is left.
  */
 const noteRejectedCall = (toolName: string, toolCallId: string): boolean => {
  if (recoverableErrors.has(toolCallId)) return true;
  if (toolName !== 'edit' && toolName !== 'complete_consolidation') return false;
  if (claimCorrection(toolName)) { recoverableErrors.add(toolCallId); return true; }
  fatalError ??= completed
   ? `${toolName} was called after completion was already submitted`
   : failed
    ? `${toolName} was rejected before execution after the run had already failed`
    : `${toolName} was rejected before execution (invalid arguments); correction budget exhausted`;
  return false;
 };
 return { result: () => failed || !completed ? undefined : { dispositions: completed }, recoverableErrors, failure: () => fatalError, noteRejectedCall };
}
