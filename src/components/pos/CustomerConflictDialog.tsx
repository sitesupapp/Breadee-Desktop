// R6 (Desktop 1.0.36) — the CUSTOMER_IDENTITY_CONFLICT verify-and-link prompt.
//
// The server returns this when a create/edit would give one operating unit two customers with the
// same canonical phone but DIFFERENT names. Nothing was written. The operator must confirm the two
// are the same person — linking to the existing record (whose saved name is kept) — or cancel and
// correct the number. Confirming re-submits the ORIGINAL capture with the single-use conflict_token
// via resolveCustomerConflict; cancelling changes nothing. OU isolation is the server's: the token
// is honoured only for the same operator, OU, matched customer and canonical number.

import { Modal } from "@/components/overlays";
import { Button } from "@/components/ui";

export function CustomerConflictDialog(props: {
  open: boolean;
  existingName: string | null;
  incomingName: string | null;
  saving: boolean;
  error: string | null;
  /** Link to the matched customer (resolveCustomerConflict with the conflict token). */
  onUseExisting: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={props.open}
      size="sm"
      title="This number is already on file"
      subtitle="A different customer in this operating unit already has this phone number."
      onClose={props.onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="lg" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" disabled={props.saving} onClick={props.onUseExisting}>
            {props.saving ? "Linking…" : "Use existing customer"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm text-ink">
        <p>
          That number belongs to{" "}
          <strong className="text-ink">{props.existingName?.trim() || "an existing customer"}</strong> in this
          operating unit.
        </p>
        {props.incomingName?.trim() && (
          <p>
            You entered the name <strong className="text-ink">{props.incomingName.trim()}</strong>.
          </p>
        )}
        <p className="text-xs text-sub">
          If this is the same person, use their existing record — their saved name is kept, nothing is overwritten. If
          it is someone else, cancel and check the number; the two are never merged automatically.
        </p>
        {props.error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{props.error}</p>
        )}
      </div>
    </Modal>
  );
}
