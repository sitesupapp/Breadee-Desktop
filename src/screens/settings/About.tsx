// Settings > About: the version, and the manual update check.
//
// The manual counterpart to the one automatic check at startup. Everything the
// automatic path hides - "you are offline", "the endpoint returned nothing
// usable" - is shown here, because here the user asked a direct question and
// silence would be the wrong answer to it.

import { useEffect } from "react";
import { Badge, Button, Card } from "@/components/ui";
import { env } from "@/env";
import { isUpdaterAvailable, unavailableReason } from "@/lib/updater";
import { useUpdates } from "@/state/updates";

export function About() {
  const s = useUpdates();
  const available = isUpdaterAvailable();
  const reason = unavailableReason();

  // Show the version the installed binary actually reports (not the Vite-baked
  // value, which a stale frontend cache can leave behind after an update), and
  // reflect a check that the banner may already have started.
  useEffect(() => {
    void useUpdates.getState().resolveVersion();
    void useUpdates.getState().checkOnStartup();
  }, []);

  const state = s.state;
  const busy = state.kind === "checking" || state.kind === "downloading" || state.kind === "installing";

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="text-lg font-extrabold text-ink">About Breadee</h2>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-[160px_1fr]">
          <dt className="text-sub">Version</dt>
          <dd className="font-bold tabular-nums text-ink">{s.version}</dd>
          <dt className="text-sub">Environment</dt>
          <dd className="font-bold text-ink">{env.APP_ENV}</dd>
          <dt className="text-sub">Platform</dt>
          <dd className="font-bold text-ink">{env.APP_PLATFORM}</dd>
        </dl>
      </Card>

      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-extrabold text-ink">Software Update</h2>
          {state.kind === "up-to-date" && <Badge tone="green">Up to date</Badge>}
          {state.kind === "available" && <Badge tone="amber">Update available</Badge>}
          {state.kind === "ready" && <Badge tone="green">Installed</Badge>}
        </div>

        {!available && <p className="mt-2 text-sm text-sub">{reason}</p>}

        {available && (
          <>
            {state.kind === "available" && (
              <div className="mt-3 rounded-xl border border-line p-3">
                <p className="text-sm font-bold text-ink">Version {state.version}</p>
                {state.date && <p className="mt-0.5 text-xs text-sub">Published {state.date}</p>}
                {state.notes && <p className="mt-2 whitespace-pre-wrap text-sm text-sub">{state.notes}</p>}
              </div>
            )}

            {state.kind === "downloading" && (
              <p className="mt-3 text-sm text-sub">
                Downloading {state.version}
                {state.percent === null ? "..." : ` - ${state.percent}%`}
              </p>
            )}

            {state.kind === "installing" && (
              <p className="mt-3 text-sm text-sub">Installing {state.version}...</p>
            )}

            {state.kind === "ready" && (
              <p className="mt-3 text-sm text-sub">
                Version {state.version} is installed. Breadee needs to restart to finish.
              </p>
            )}

            {/* Errors are shown here and nowhere else. The app is running fine;
                this is information, not an alarm. */}
            {state.kind === "error" && (
              <p className="mt-3 text-sm text-red-700">{state.message}</p>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="ghost" disabled={busy} onClick={() => void s.check({ silent: false })}>
                {state.kind === "checking" ? "Checking..." : "Check for updates"}
              </Button>
              {state.kind === "available" && (
                <Button disabled={busy} onClick={() => void s.install()}>
                  Update &amp; Restart
                </Button>
              )}
              {state.kind === "ready" && <Button onClick={() => void s.restart()}>Restart now</Button>}
            </div>

            <p className="mt-3 text-xs text-sub">
              Updates are signed by Breadee and verified before they are installed. Breadee never restarts on its own -
              you choose when.
            </p>
          </>
        )}
      </Card>
    </div>
  );
}
