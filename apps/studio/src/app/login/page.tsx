import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Button, Input } from "@/components/ui";
import { inline } from "@/components/settings/inline";
import { Mark } from "@/components/shell/wordmark";
import { authSettings, safeNext } from "@/server/auth";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  wrong: "That key doesn't match. Check ATTENTIONOS_STUDIO_TOKEN in your workspace .env.",
  limited: "Too many tries. Wait a few minutes, then try again.",
  unset: "Studio has no access key yet. Set ATTENTIONOS_STUDIO_TOKEN in the stack's .env, then run `./aos restart`.",
  bad: "Something went wrong reading that. Try again.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const one = (k: string) => (Array.isArray(params[k]) ? params[k][0] : params[k]);
  const next = safeNext(one("next"));
  if (authSettings().mode === "none") redirect(next);
  const error = ERRORS[one("error") ?? ""];
  const signedOut = one("signedOut") === "1";

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-16">
      <div className="w-full max-w-[400px]">
        <Mark size={44} className="mb-8" />
        <h1 className="font-display text-display-l text-fg">Open your studio</h1>
        <p className="mt-3 text-body text-fg-2">Enter the access key for this workspace. You&apos;ll stay signed in on this browser for 30 days.</p>

        <form method="post" action="/api/auth/login" className="mt-10 flex flex-col gap-4">
          <input type="hidden" name="next" value={next} />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="token" className="text-small font-medium text-fg">
              Access key
            </label>
            <Input
              id="token"
              name="token"
              type="password"
              required
              autoFocus
              autoComplete="current-password"
              spellCheck={false}
              className="h-11 font-mono"
              aria-invalid={error ? true : undefined}
              aria-describedby="token-help"
            />
            {error ? (
              <p id="token-help" role="alert" className="text-caption text-danger">
                {inline(error)}
              </p>
            ) : (
              <p id="token-help" className="text-caption text-fg-3">
                {inline(`${signedOut ? "Signed out. " : ""}It's ATTENTIONOS_STUDIO_TOKEN in the workspace .env, printed when you first ran \`attentionos up\`.`)}
              </p>
            )}
          </div>
          <Button type="submit" variant="primary" size="lg" className="w-full">
            Open Studio
          </Button>
        </form>
      </div>
    </main>
  );
}
