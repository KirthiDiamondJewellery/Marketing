import type { Metadata, Viewport } from "next";
import "./globals.css";


export const metadata: Metadata = {
  title: { default: "AttentionOS Studio", template: "%s · AttentionOS" },
  description: "Your AI content team, live.",
};

export const viewport: Viewport = { themeColor: "#08070b", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
