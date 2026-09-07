/** Deterministic input errors must not consume a transient worker's retry budget. */
export class WorkerInputLimitError extends Error {}

export function checkWorkerInput(input: string, limit: number): void {
 const bytes = Buffer.byteLength(input);
 if (bytes > limit) throw new WorkerInputLimitError(
  `Input is ${bytes} bytes, above maxWorkerPromptBytes=${limit}; nothing was truncated or marked covered. ` +
  'OM is blocked for this role. Raise maxWorkerPromptBytes if the model has room, then /reload; otherwise leave OM off for this session.',
 );
}
