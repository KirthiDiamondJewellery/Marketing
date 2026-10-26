import { Wordmark } from "./wordmark";

/** Shown instead of the shell when Studio has no workspace or database to talk to. */
export function SetupNeeded({ message }: { message: string }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-4">
      <div className="flex max-w-md flex-col items-center text-center">
        <Wordmark />
        <h1 className="mt-10 text-h2 font-medium text-fg">Studio isn't connected to a workspace</h1>
        <p className="mt-2 text-body text-fg-2">{message}</p>
        <code className="mt-6 rounded-md bg-surface-2 px-3 py-2 font-mono text-log text-fg">./aos start</code>
      </div>
    </main>
  );
}
