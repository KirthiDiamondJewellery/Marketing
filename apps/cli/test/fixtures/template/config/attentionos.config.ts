import { defineConfig } from "attentionos/config";

export default defineConfig({
  workspace: {
    id: "{{WORKSPACE_ID}}",
    name: "{{WORKSPACE_NAME}}",
    preset: "{{PRESET}}",
    timezone: "{{TIMEZONE}}",
  },
  northStar: { metric: "leads_per_week" },
});
