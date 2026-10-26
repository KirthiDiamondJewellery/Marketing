"use client";

/** Monochrome 16px platform marks (DESIGN §10: icons identify platforms, never color the UI). Inherit currentColor. */
export function PlatformGlyph({ platform, size = 16 }: { platform: string; size?: number }) {
  const p = platform.toLowerCase();
  const common = { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-label": PLATFORM_NAMES[p] ?? platform, role: "img" };
  switch (p) {
    case "instagram":
      return (
        <svg {...common}>
          <rect x="2" y="2" width="12" height="12" rx="3.5" />
          <circle cx="8" cy="8" r="2.7" />
          <circle cx="11.6" cy="4.4" r="0.4" fill="currentColor" stroke="none" />
        </svg>
      );
    case "tiktok":
      return (
        <svg {...common}>
          <path d="M9.5 2v8.2a2.6 2.6 0 1 1-2.6-2.6" />
          <path d="M9.5 2c.3 1.9 1.6 3.1 3.5 3.3" />
        </svg>
      );
    case "youtube":
      return (
        <svg {...common}>
          <rect x="1.5" y="3.5" width="13" height="9" rx="2.6" />
          <path d="M6.8 6.1v3.8L10 8z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "linkedin":
      return (
        <svg {...common}>
          <rect x="2" y="2" width="12" height="12" rx="2" />
          <path d="M5.2 7v4M5.2 5v.01M7.8 11V7M7.8 8.8c0-1.1.8-1.8 1.7-1.8s1.5.6 1.5 1.7V11" />
        </svg>
      );
    case "facebook":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.2" />
          <path d="M9.6 5.2H8.8c-.8 0-1.2.4-1.2 1.2V14M6.2 8.4h3.2" />
        </svg>
      );
    case "x":
    case "twitter":
      return (
        <svg {...common}>
          <path d="M3 3l10 10M13 3L3 13" />
        </svg>
      );
    case "threads":
      return (
        <svg {...common}>
          <path d="M11.2 6.3C10.7 4.6 9.5 3.8 8 3.8c-2.4 0-3.8 1.8-3.8 4.2s1.4 4.2 3.9 4.2c2 0 3.5-1.1 3.5-2.8 0-1.4-1.1-2.2-2.6-2.2-1.3 0-2.1.6-2.1 1.5 0 .8.7 1.3 1.6 1.3 1.5 0 2.2-1.2 2.2-3" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" />
        </svg>
      );
  }
}

export const PLATFORM_NAMES: Record<string, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  x: "X",
  twitter: "X",
  threads: "Threads",
};
