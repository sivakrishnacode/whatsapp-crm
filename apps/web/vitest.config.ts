import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Dummy secrets — encryption.ts / webhook-signature.ts read these
    // at module load. Tests never hit a real Meta/Supabase service, so
    // any 32-byte hex / non-empty string will do; keep them lexically
    // identical to the CI build env so behaviour matches.
    env: {
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test-meta-app-secret",
      // Ads Manager is off by default in every real environment, but its
      // nav wiring is only reachable when on — so tests run with it
      // enabled. The off case is covered explicitly in
      // lib/nav/ads-nav.test.ts, which re-imports with the flag cleared.
      NEXT_PUBLIC_ADS_MANAGER_ENABLED: "true",
    },
    clearMocks: true,
  },
});
