// Phone normalisation, checked against the server's `_phone_normalize_e164`.
//
// This is not cosmetic formatting. It is the only mechanism that can tell the
// desktop that "03 123 456" and "+9613123456" are one customer, because the
// database cannot: `uq_pos_customer_phone` is unique on the RAW string, and
// `phone_e164` has a non-unique index. Every case below is one the cashier can
// actually type, and each one that normalises to the same string is a duplicate
// that would otherwise be created without complaint.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_DIAL,
  LOCAL_LENGTHS,
  looksLikePhone,
  normalizePhoneE164,
  phoneDigits,
  samePhone,
} from "@/lib/pos/phone";

test("the defaults are the server's: dial 961, local lengths 7 and 8", () => {
  assert.equal(DEFAULT_DIAL, "961");
  assert.deepEqual([...LOCAL_LENGTHS], [7, 8]);
});

test("a bare local number gains the dial code", () => {
  assert.equal(normalizePhoneE164("3123456"), "+9613123456");
  assert.equal(normalizePhoneE164("71123456"), "+96171123456");
});

test("the trunk zero is dropped, not kept", () => {
  assert.equal(normalizePhoneE164("03123456"), "+9613123456");
  assert.equal(normalizePhoneE164("071123456"), "+96171123456");
});

test("punctuation and spaces are ignored", () => {
  assert.equal(normalizePhoneE164("03 123 456"), "+9613123456");
  assert.equal(normalizePhoneE164("(03) 123-456"), "+9613123456");
  assert.equal(normalizePhoneE164("03.123.456"), "+9613123456");
});

test("a leading 00 is the written form of +", () => {
  assert.equal(normalizePhoneE164("009613123456"), "+9613123456");
});

test("an explicit + with the dial code passes through", () => {
  assert.equal(normalizePhoneE164("+9613123456"), "+9613123456");
  assert.equal(normalizePhoneE164("+961 3 123 456"), "+9613123456");
});

test("a trunk zero after the country code is removed", () => {
  // "+961 03 123456" - typed by someone reading a local number aloud.
  assert.equal(normalizePhoneE164("+96103123456"), "+9613123456");
});

test("the dial code typed twice collapses to one", () => {
  assert.equal(normalizePhoneE164("+9619613123456"), "+9613123456");
});

test("THE DUPLICATE SET: every way of typing one number agrees", () => {
  const forms = ["03123456", "03 123 456", "+9613123456", "009613123456", "+961 03 123456", "(03)123-456"];
  const normalised = forms.map((f) => normalizePhoneE164(f));
  assert.deepEqual(new Set(normalised), new Set(["+9613123456"]));
  // Stated the other way round, because this is the assertion that matters:
  // the database would accept all six of these as separate customers.
  assert.equal(new Set(normalised).size, 1);
});

test("a foreign number keeps its own country code", () => {
  assert.equal(normalizePhoneE164("+971501234567"), "+971501234567");
  assert.equal(normalizePhoneE164("00971501234567"), "+971501234567");
});

test("a foreign number outside 8-15 digits is refused", () => {
  assert.equal(normalizePhoneE164("+1234567"), null);
  assert.equal(normalizePhoneE164("+1234567890123456"), null);
});

test("a local number of the wrong length is refused, not padded", () => {
  assert.equal(normalizePhoneE164("312345"), null);
  assert.equal(normalizePhoneE164("312345678"), null);
});

test("letters and empty input normalise to null", () => {
  assert.equal(normalizePhoneE164("ahmad"), null);
  assert.equal(normalizePhoneE164("03123456 ext 2"), null);
  assert.equal(normalizePhoneE164(""), null);
  assert.equal(normalizePhoneE164("   "), null);
  assert.equal(normalizePhoneE164(null), null);
  assert.equal(normalizePhoneE164(undefined), null);
});

test("Arabic-Indic digits are folded like the server does", () => {
  assert.equal(normalizePhoneE164("٠٣١٢٣٤٥٦"), "+9613123456");
  assert.equal(normalizePhoneE164("۰۳۱۲۳۴۵۶"), "+9613123456");
});

test("samePhone matches across formats", () => {
  assert.equal(samePhone("03123456", "+9613123456"), true);
  assert.equal(samePhone("03 123 456", "009613123456"), true);
});

test("samePhone is false for different subscribers", () => {
  assert.equal(samePhone("03123456", "03123457"), false);
});

test("two unparseable numbers are NOT the same customer", () => {
  // If this were true, a cashier could never create a customer while junk was
  // in the search box - every candidate would look like a match.
  assert.equal(samePhone("ahmad", "ahmad"), false);
  assert.equal(samePhone(null, null), false);
  assert.equal(samePhone("", ""), false);
});

test("looksLikePhone needs four digits and no letters", () => {
  assert.equal(looksLikePhone("0312"), true);
  assert.equal(looksLikePhone("03 123 456"), true);
  assert.equal(looksLikePhone("+961"), false);
  assert.equal(looksLikePhone("031"), false);
  assert.equal(looksLikePhone("ahmad"), false);
  assert.equal(looksLikePhone("ahmad 03123456"), false);
  assert.equal(looksLikePhone(""), false);
});

test("phoneDigits strips everything but digits", () => {
  assert.equal(phoneDigits("+961 (3) 123-456"), "9613123456");
  assert.equal(phoneDigits("٠٣١٢٣٤٥٦"), "03123456");
  assert.equal(phoneDigits(null), "");
});

test("a custom dial and local length are honoured", () => {
  // Proof this is a port of a parameterised function, not a Lebanon-only hack.
  assert.equal(normalizePhoneE164("0501234567", "971", [9]), "+971501234567");
});
