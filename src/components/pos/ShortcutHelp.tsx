// F1 shortcut sheet.
//
// Rendered from the same table the dispatcher reads, so the help can never drift
// from the actual bindings.

import { Modal } from "@/components/overlays";
import { shortcutHelp } from "@/lib/keyboard/shortcuts";
import { useKeyboardHelp } from "@/lib/keyboard/provider";

export function ShortcutHelp() {
  const { helpOpen, setHelpOpen } = useKeyboardHelp();
  const groups = shortcutHelp();

  return (
    <Modal
      open={helpOpen}
      title="Keyboard shortcuts"
      subtitle="A full takeaway order can be completed without a mouse."
      size="md"
      onClose={() => setHelpOpen(false)}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {groups.map((g) => (
          <div key={g.group}>
            <p className="mb-2 text-xs font-extrabold uppercase tracking-wide text-sub">{g.group}</p>
            <ul className="space-y-1">
              {g.items.map((item) => (
                <li key={`${g.group}-${item.display}-${item.label}`} className="flex items-center justify-between gap-3">
                  <span className="text-sm text-ink">{item.label}</span>
                  <kbd className="shrink-0 rounded-md border border-line bg-slate-50 px-2 py-0.5 font-mono text-xs font-bold text-sub">
                    {item.display}
                  </kbd>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Modal>
  );
}
