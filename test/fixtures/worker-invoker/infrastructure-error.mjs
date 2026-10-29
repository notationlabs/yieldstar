process.on("message", () => {
  process.send({
    status: "error",
    error: { name: "Error", message: "database is locked" },
  });
});

process.send({ status: "ready" });
