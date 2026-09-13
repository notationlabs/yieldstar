import { defineConfig } from "@pokit/core";
import { docs } from "pok-plugins";

export default defineConfig({
  commandsDir: "./commands",
  appName: "yieldstar",
  plugins: [docs({ name: "yieldstar-docs" })],
});
