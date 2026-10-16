import { defineConfig } from "vite";
import { docs } from "@notation/docs";

export default defineConfig({
  plugins: [
    docs({
      title: "Yieldstar – Durable workflow engine for TypeScript",
      github: "https://github.com/notationlabs/yieldstar",
      favicon:
        "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🤘</text></svg>",
      categories: ["manual", "runtimes", "packages"],
      // Served at notation.dev/yieldstar rather than on its own subdomain.
      basePath: "/yieldstar",
      // The site now lives inside the docs directory it publishes, so the
      // Markdown and nav metadata sit alongside this config.
      contentDirectory: ".",
      pagesDirectory: "pages",
      logo: "./views/logo.tsx",
      version: { packageJson: "package.json" },
      deployment: {
        name: "yieldstar-docs",
        compatibilityDate: "2025-09-24",
        compatibilityFlags: ["nodejs_compat"],
        // notation.dev itself is the notation-docs Custom Domain; routes run
        // ahead of it, so these paths reach this Worker instead.
        routes: [
          { pattern: "notation.dev/yieldstar", zoneName: "notation.dev" },
          { pattern: "notation.dev/yieldstar/*", zoneName: "notation.dev" },
        ],
      },
    }),
  ],
});
