import { defineRailway, github, preserve, project, service } from "railway/iac";

// Railway Infrastructure-as-Code for the analyser (2026-09-09). Applied with
// `railway config plan` → `railway config apply` from this folder — NOT on git push.
// ⚠️ A plan that says "destroy" or "Delete variable" is WRONG: the four API keys are
// preserve()d here on purpose; never apply a plan that removes them or the GitHub source.

export default defineRailway(() => {
  const influencerfounderVideoAnalyser = service("influencerfounder-video-analyser", {
    source: github("influencerfounder/influencerfounder-video-analyser", { checkSuites: false }),
    // EU West Metal (Amsterdam) — Vercel's functions run in Frankfurt and the students are in
    // Europe; the service sat in US West ("sfo") until 2026-09-09, so every analysis crossed
    // the Atlantic twice through two Railway edge hops. No volume attached → no downtime.
    replicas: { "europe-west4-drams3a": 1 },
    // Railway only routes traffic to a new container once GET / answers (the tool's incident
    // probe reads the same route) — removes the redeploy-window 502s. Was railway.json
    // (deprecated Config-as-Code, migrated 2026-09-09).
    healthcheck: "/",
    healthcheckTimeout: 300,
    env: { ANTHROPIC_API_KEY: preserve(), APIFY_API_KEY: preserve(), GROQ_API_KEY: preserve(), KIE_API_KEY: preserve() },
  });

  return project("influencerfounder-video-analyser", {
    resources: [influencerfounderVideoAnalyser],
  });
});
