process.on("message", () => {
  process.send({
    status: "error",
    error: JSON.stringify({ $type: "error", name: "Error", message: "database is locked" }),
  });
});

process.send({ status: "ready" });
