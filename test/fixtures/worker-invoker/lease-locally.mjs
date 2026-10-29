// Parity runners each own an in-memory runtime, so the parent's lease is not
// current there. Admit and lease the execution locally, then run it under
// that lease, so heap writes are fenced as they would be in a shared runtime.
export function leaseLocally(runtime, runner) {
  return {
    async run(event, { signal, logger }) {
      await runtime.executions.admit({
        executionId: event.executionId,
        workflowId: event.workflowId,
        params: event.params,
        context: event.context,
      });
      const [lease] = await runtime.executions.claimDue({ limit: 1, duration: 30_000 });
      return runner.run(event, { lease, signal, logger });
    },
  };
}
