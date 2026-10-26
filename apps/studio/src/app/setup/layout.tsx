import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Set up your team" };

/** The setup wizard runs full screen, outside the OS shell (no nav, no agent stream). */
export default function SetupLayout({ children }: { children: ReactNode }) {
  return children;
}
