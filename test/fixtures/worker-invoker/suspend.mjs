process.on("message", () => {
  process.send({ status: "outcome", outcome: { status: "suspended", wakeAt: 1234 } });
});

process.send({ status: "ready" });
