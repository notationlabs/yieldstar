import type { DocCategory } from "@notation/docs/config";

export const packages: DocCategory = {
  label: "Packages",
  slug: "packages",
  sections: [
    {
      heading: "Reference",
      icon: "terminal",
      links: [
        { label: "yieldstar", slug: "packages/yieldstar" },
        { label: "core", slug: "packages/core" },
        { label: "http-server", slug: "packages/http-server" },
        { label: "sqlite-runtime", slug: "packages/sqlite-runtime" },
        { label: "worker-invoker", slug: "packages/worker-invoker" },
        {
          label: "runtime-conformance",
          slug: "packages/runtime-conformance",
        },
      ],
    },
  ],
};
