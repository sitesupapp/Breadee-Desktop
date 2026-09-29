import { useState } from "react";
import { Button } from "@/components/ui";
import { Glyph } from "@/components/Glyph";
import { WHATS_NEW_PAGES, markWhatsNewSeen, shouldShowWhatsNew } from "@/lib/whatsNew";

// Once-per-version highlight of the release. Rendered from the Shell; it decides for
// itself whether to open (first launch on this version) and persists "seen" on Done, so
// a relaunch does not reopen it. Next / Back / Done; a small dot per page. Purely local.
export function WhatsNew() {
  const [open, setOpen] = useState(() => shouldShowWhatsNew());
  const [i, setI] = useState(0);

  if (!open || WHATS_NEW_PAGES.length === 0) return null;

  const page = WHATS_NEW_PAGES[i];
  const isFirst = i === 0;
  const isLast = i === WHATS_NEW_PAGES.length - 1;

  const done = () => {
    markWhatsNewSeen();
    setOpen(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="What's new">
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex flex-col items-center gap-3 px-6 pb-4 pt-8 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-soft text-brand-dark">
            <Glyph name={page.glyph} size={34} />
          </div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-sub">What&apos;s new · {i + 1} of {WHATS_NEW_PAGES.length}</p>
          <h2 className="text-lg font-extrabold text-ink">{page.title}</h2>
          <p className="text-sm leading-relaxed text-sub">{page.body}</p>
        </div>

        <div className="flex items-center justify-center gap-1.5 pb-4">
          {WHATS_NEW_PAGES.map((_, d) => (
            <span key={d} className={`h-1.5 rounded-full transition-all ${d === i ? "w-4 bg-brand" : "w-1.5 bg-slate-300"}`} />
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={done}
            className="text-xs font-semibold text-sub hover:text-ink"
          >
            Skip
          </button>
          <div className="flex items-center gap-2">
            {!isFirst && (
              <Button variant="ghost" size="md" onClick={() => setI((n) => Math.max(0, n - 1))}>
                Back
              </Button>
            )}
            {isLast ? (
              <Button size="md" onClick={done}>Done</Button>
            ) : (
              <Button size="md" onClick={() => setI((n) => Math.min(WHATS_NEW_PAGES.length - 1, n + 1))}>Next</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
