// The bridge between "what the tenant designed" and "what gets drawn".
//
// ONE OBJECT, TWO RENDERERS. The on-screen preview and the native printer both
// take a `ReceiptRenderOptions` built by this module from the same settings row
// and the same QR matrix, so a block switched off in the designer disappears
// from both, and a code approved on screen is the code on the paper. Building
// them separately is precisely how a preview comes to describe a document
// nobody printed.
//
// NOTHING HERE READS A SETTING OR ENCODES ANYTHING. It is a pure mapping, so
// the rule that matters - "no template means draw everything" - is a function a
// test can call rather than a branch buried in a component.

import type { ReceiptDesignSettings } from "@/lib/pos/receiptSettings";
import { visibleBlocks } from "@/lib/pos/receiptTemplate";
import type { QrMatrix } from "@/lib/pos/qrCode";

/** Everything a renderer needs beyond the order itself. */
export type ReceiptRenderOptions = {
  /**
   * Block keys to draw, in stored order, or null for "no template - draw
   * everything".
   *
   * NULL IS THE SAFE DIRECTION HERE, and deliberately the opposite of
   * `AUTO_PRINT_UNKNOWN`. An unreadable settings row must not be able to
   * silently remove the TOTAL from a customer's receipt; it may safely leave a
   * line on that somebody had switched off.
   */
  sections: string[] | null;
  address: string | null;
  phone: string | null;
  welcome: string | null;
  footer: string | null;
  qr: QrMatrix | null;
};

/** What a terminal that could not read the settings uses. */
export const DEFAULT_RENDER_OPTIONS: ReceiptRenderOptions = {
  sections: null,
  address: null,
  phone: null,
  welcome: null,
  footer: null,
  qr: null,
};

export function customerRenderOptions(input: {
  design: ReceiptDesignSettings | null;
  /** Already encoded, and already gated on the local "show payment QR" switch. */
  qr: QrMatrix | null;
}): ReceiptRenderOptions {
  const { design } = input;
  if (!design) return { ...DEFAULT_RENDER_OPTIONS, qr: input.qr };
  return {
    sections: visibleBlocks(design.customer),
    address: design.headerAddress,
    phone: design.headerPhone,
    welcome: design.welcomeMessage,
    footer: design.footerMessage,
    qr: input.qr,
  };
}

/** The kitchen ticket's subset. No address, no phone, no welcome, no QR. */
export type KitchenRenderOptions = { sections: string[] | null; footer: string | null };

export const DEFAULT_KITCHEN_RENDER_OPTIONS: KitchenRenderOptions = { sections: null, footer: null };

export function kitchenRenderOptions(design: ReceiptDesignSettings | null): KitchenRenderOptions {
  if (!design) return DEFAULT_KITCHEN_RENDER_OPTIONS;
  return { sections: visibleBlocks(design.kitchen), footer: design.footerMessage };
}
