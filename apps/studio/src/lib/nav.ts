/** Studio routes, in nav order: make content, post it, see how it does. */
export const NAV = [
  { href: "/", label: "Home", icon: "House" },
  { href: "/scripts", label: "Scripts", icon: "FileText" },
  { href: "/edit", label: "Edit", icon: "Scissors" },
  { href: "/calendar", label: "Calendar", icon: "CalendarDays" },
  { href: "/agents", label: "Agents", icon: "Bot" },
  { href: "/analytics", label: "Analytics", icon: "ChartLine" },
  { href: "/brand", label: "Brand Kit", icon: "BookOpen" },
  { href: "/settings", label: "Settings", icon: "Settings" },
] as const;

/** Old addresses, kept working: each one now lives inside one of the pages above. */
export const MOVED: Record<string, string> = {
  "/film": "/scripts",
  "/edits": "/edit",
  "/approvals": "/",
  "/command": "/agents?view=command",
  "/research": "/analytics/competitors",
  "/insights": "/analytics",
  "/content": "/calendar",
};
