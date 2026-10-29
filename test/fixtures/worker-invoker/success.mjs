process.on("message", ({ event, lease }) => {
  const context = new Map(JSON.parse(event.context));
  process.send({
    status: "outcome",
    outcome: {
      status: "completed",
      result: JSON.stringify(
        context.get("requestId") === "request" &&
          lease.executionId === event.executionId &&
          typeof lease.token === "number"
      ),
    },
  });
});

process.send({ status: "ready" });
