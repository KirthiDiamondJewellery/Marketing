export const LIFECYCLE_LABEL: Record<string, string> = {
  idea: "Idea",
  scripted: "Scripted",
  filming: "Filming",
  editing: "Editing",
  review: "Review",
  scheduled: "Scheduled",
  published: "Published",
  measured: "Measured",
  archived: "Archived",
};

export const LIFECYCLE_STEPS = ["idea", "scripted", "filming", "editing", "review", "scheduled", "published", "measured"] as const;
