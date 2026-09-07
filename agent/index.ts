import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { trackWorkerCost } from './cost.js';
import { CONSOLIDATOR_SYSTEM } from './consolidator/prompt.js';
import { registerConsolidatorTools } from './consolidator/tools.js';
import { OBSERVER_SYSTEM } from './observer/prompt.js';
import { registerObserverTool } from './observer/tool.js';
import { cleanWorkerEnd, readRequest, writeReceipt, writeFailure } from '../src/spawn/receipt.js';
import { writeActivity } from '../src/spawn/activity.js';

/** Receipts are written by trusted extension code, only after an explicitly completed clean run. */
export default function omWorker(pi: ExtensionAPI): void {
 const { OM_WORKER: role, OM_RESULT_PATH: resultPath, OM_MEMORY_DIR: root, OM_REQUEST_PATH: requestPath } = process.env;
 if (!resultPath || !root || !requestPath) throw new Error('missing worker IPC configuration');
 const request = readRequest(requestPath);
 if (request.role !== role || request.runId !== process.env.OM_RUN_ID) throw new Error('worker request identity mismatch');
 trackWorkerCost(pi);
 const consolidator = role === 'consolidator' ? registerConsolidatorTools(pi, root, request) : undefined;
 const worker = consolidator ?? registerObserverTool(pi);
 const recoverableErrors = consolidator?.recoverableErrors ?? new Set<string>();
 let terminalFailure: string | undefined;
 let writes = 0;
 pi.on('tool_execution_end', (event, ctx) => {
  if (!event.isError && ['write','edit'].includes(event.toolName)) writes++;
  writeActivity(root,{runId:request.runId,tool:event.toolName,writes,at:Date.now(),error:event.isError});
  if (event.isError && !recoverableErrors.has(event.toolCallId)) {
   terminalFailure = consolidator?.failure() ?? `${event.toolName} failed; worker stopped without committing observations`;
   try { writeFailure(resultPath,request,terminalFailure); }
   finally { ctx.abort(); }
  }
 });
 pi.on('before_agent_start', async () => ({ systemPrompt: role === 'observer' ? OBSERVER_SYSTEM : CONSOLIDATOR_SYSTEM }));
 pi.on('agent_end', async (event, ctx) => {
  try {
   const result = worker.result();
   if (!terminalFailure && result && cleanWorkerEnd(event,recoverableErrors)) writeReceipt(resultPath, request, result);
   else writeFailure(resultPath,request,terminalFailure ?? (result ? 'model did not end cleanly' : 'no accepted completion was submitted'));
  } finally { ctx.shutdown(); }
 });
}
