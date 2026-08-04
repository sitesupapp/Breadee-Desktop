// Edit the kitchen note on an existing cart line.
//
// Split out from the modifier chooser so a note can be added or corrected after
// the line is already in the cart - which is what actually happens at a counter.

import { useEffect, useState } from "react";
import { Modal } from "@/components/overlays";
import { Button, Textarea } from "@/components/ui";

export function LineNoteDialog({
  open,
  lineName,
  initialNote,
  onCancel,
  onSave,
}: {
  open: boolean;
  lineName: string;
  initialNote: string | null;
  onCancel: () => void;
  onSave: (note: string | null) => void;
}) {
  const [note, setNote] = useState(initialNote ?? "");

  useEffect(() => {
    if (open) setNote(initialNote ?? "");
  }, [open, initialNote]);

  return (
    <Modal
      open={open}
      title="Kitchen note"
      subtitle={lineName}
      size="sm"
      onClose={onCancel}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={() => onSave(note.trim() ? note.trim() : null)}>Save note</Button>
        </div>
      }
    >
      <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. no onions, well done" autoFocus />
      <p className="mt-2 text-xs text-sub">The note travels with this line to the kitchen and appears on the receipt.</p>
    </Modal>
  );
}
