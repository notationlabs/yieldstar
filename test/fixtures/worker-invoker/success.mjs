process.on("message", ({ event, lease }) => {
  process.send({
    status: "outcome",
    outcome: {
      status: "completed",
      result:
        event.context instanceof Map &&
        event.context.get("requestId") === "request" &&
        lease.executionId === event.executionId &&
        typeof lease.token === "number",
    },
  });
});

process.send({ status: "ready" });
