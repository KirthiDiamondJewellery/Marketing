/** The notices from docs/notices.md, shown inline next to their switches. Keep the two in sync. */
const DOCS = "https://github.com/evanbaker315/AttentionOS/blob/main/docs/notices.md";

export const NOTICES: Record<string, { title: string; usedBy: string; body: string; alternative?: string; href: string }> = {
  scrapingTerms: {
    title: "Reading public posts through a third-party service",
    usedBy: "Research",
    body: "Collecting public posts through a scraping service may conflict with a platform's terms, and platforms can change what they allow at any time. AttentionOS only reads the accounts you list in brand/competitors.yaml, never logs in as you, never automates a browser, and checks your research budget before every run.",
    alternative: "Alternative: the official Instagram Graph API (scraper: \"iggraph\") reads public business and creator accounts without this notice.",
    href: `${DOCS}#reading-public-posts-through-a-third-party-service-scrapingterms`,
  },
  automatedDmRisk: {
    title: "Automated replies in DMs",
    usedBy: "Community",
    body: "Automated direct messages are governed by each platform's messaging rules, and Instagram limits what you can send to people who haven't messaged you first. AttentionOS creates keyword automations through your publishing provider's official API, drafts every other reply for your approval, and never sends a free-form DM without it.",
    href: `${DOCS}#automated-replies-in-dms-automateddmrisk`,
  },
  trialReelsRisk: {
    title: "Trial reels",
    usedBy: "Trial reels",
    body: "Trial reels are shown to non-followers first. Many near-identical variations can look like spam and may reduce reach. AttentionOS caps trial reels per day, requires a one-time proof run, and never posts variations without your approval.",
    href: `${DOCS}#trial-reels-trialreelsrisk`,
  },
  remotionLicense: {
    title: "Remotion company license",
    usedBy: "Editing (motion engine)",
    body: "Remotion is free for individuals and companies of up to three people. Larger companies need a paid Remotion company license. The default cut engine has no such requirement.",
    href: `${DOCS}#remotion-company-license-remotionlicense`,
  },
};
