// Phase 2 (Desktop 1.0.31): the mandatory reason prompt for removing or reducing a
// persisted dine-in line. Modelled on ClearTableDialog — a preset catalogue plus an
// "Other" free-text choice, Confirm disabled until a valid reason is chosen, and an
// "Audited" note. The reason is an audit snapshot; it never changes money or state.

import { useEffect, useState } from "react";
import { Modal } from "@/components/overlays";
import { Badge, Button, Input, cn } from "@/components/ui";
import { EDIT_REASON_OTHER, EDIT_REASON_PRESETS, resolveEditReason } from "@/lib/pos/editReason";

export function EditReasonDialog({
  open,
  title,
  subtitle,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  subtitle: string;
  busy?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [preset, setPreset] = useState<string | null>(null);
  const [otherText, setOtherText] = useState("");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setPreset(null);
      setOtherText("");
      setTouched(false);
    }
  }, [open]);

  const { reason, error } = resolveEditReason({ preset, otherText });
  const showError = touched && error !== null;
  const canConfirm = !busy && reason !== null;
  const choices: string[] = [...EDIT_REASON_PRESETS, EDIT_REASON_OTHER];

  return (
    <Modal
      open={open}
      title={title}
      subtitle={subtitle}
      size="md"
      onClose={onCancel}
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {showError && <p className="truncate text-xs font-semibold text-amber-800">{error}</p>}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" size="lg" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button
              size="lg"
              onClick={() => {
                setTouched(true);
                if (reason !== null) onConfirm(reason);
              }}
              disabled={!canConfirm}
              title={error ?? undefined}
            >
              {busy ? "Working..." : "Confirm"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-wrap gap-2">
        {choices.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => {
              setPreset(c);
              setTouched(true);
            }}
            className={cn(
              "min-h-[44px] rounded-full border px-3 text-xs font-semibold",
              preset === c ? "border-brand bg-brand-soft text-ink" : "border-line bg-white text-sub hover:bg-slate-50",
            )}
          >
            {c}
          </button>
        ))}
      </div>

      {preset === EDIT_REASON_OTHER && (
        <div className="mt-3">
          <label className="mb-1 block text-sm font-bold text-ink" htmlFor="edit-reason-other">
            Reason
          </label>
          <Input
            id="edit-reason-other"
            size="lg"
            value={otherText}
            onChange={(e) => {
              setOtherText(e.target.value);
              setTouched(true);
            }}
            placeholder="Recorded against your account"
            autoComplete="off"
          />
        </div>
      )}

      <p className="mt-3 flex items-center gap-2 text-[11px] text-sub">
        <Badge tone="slate">Audited</Badge>
        The reason and your account are written to the activity log.
      </p>
    </Modal>
  );
}
