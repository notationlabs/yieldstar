process.on("message", (event) => {
  process.send({
    status: "outcome",
    outcome: {
      status: "completed",
      result:
        event.context instanceof Map &&
        event.context.get("requestId") === "request",
    },
  });
});

process.send({ status: "ready" });
