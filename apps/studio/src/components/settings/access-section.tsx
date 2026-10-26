"use client";
import { Badge, Button, Card } from "@/components/ui";
import type { SettingsData } from "./settings-view";

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|::1)$/;

export function AccessSection({ access, version }: { access: SettingsData["access"]; version: string }) {
  const local = LOOPBACK.test(access.host);
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card className="flex flex-col gap-4">
        <div>
          <div className="text-small text-fg-2">Listening on</div>
          <div className="mt-0.5 font-mono text-body text-fg">
            {access.host.includes(":") ? `[${access.host}]` : access.host}:{access.port}
          </div>
        </div>
        <ul className="flex flex-col gap-2">
          {access.urls.map((u) => (
            <li key={u.url} className="flex flex-wrap items-center justify-between gap-2">
              <a href={u.url} className="font-mono text-small text-fg underline decoration-border-strong underline-offset-4 hover:decoration-fg">
                {u.url}
              </a>
              <span className="text-caption text-fg-3">{u.label}</span>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          {access.signIn ? <Badge tone="success">Sign-in required</Badge> : <Badge>No sign-in on this computer</Badge>}
          {access.trustTailscale ? <Badge tone="info">Tailscale identity accepted</Badge> : null}
          {access.workerEmbedded ? <Badge tone="success">Worker runs with Studio</Badge> : null}
        </div>
        {access.signIn ? (
          <form method="post" action="/api/auth/logout">
            <Button type="submit" variant="ghost" size="sm">
              Sign out of this browser
            </Button>
          </form>
        ) : null}
        <p className="text-caption text-fg-3">AttentionOS {version}</p>
      </Card>

      <Card className="flex flex-col gap-3">
        <div className="text-h3 font-medium text-fg">Open Studio on another device</div>
        {local ? (
          <>
            <p className="text-small text-fg-2">Studio only listens on this computer, so nothing else on your network or the internet can open it.</p>
            <ul className="list-disc space-y-1.5 pl-5 text-small text-fg-2">
              <li>
                Running on a server? Open it through an SSH tunnel: <span className="font-mono text-fg">ssh -N -L {access.port}:127.0.0.1:{access.port} you@your-server</span>, then{" "}
                <span className="font-mono text-fg">http://localhost:{access.port}</span>.
              </li>
              <li>On your phone, the Telegram or Discord bot brings you the brief, approvals and notes.</li>
            </ul>
          </>
        ) : (
          <p className="text-small text-fg-2">Studio is reachable on this network. Open one of the addresses on the left from a device on the same network, and sign in with your access key.</p>
        )}
      </Card>
    </div>
  );
}
