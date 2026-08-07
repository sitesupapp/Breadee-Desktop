// Shared helpers for the source-reading tests.
//
// Not named `*.test.ts`, so the runner's `test/*.test.ts` glob does not pick it
// up as a suite - and so importing it from several test files does not register
// anybody's tests twice.

/**
 * Source with its comments removed.
 *
 * Several POS modules DOCUMENT the rules they follow - "the client never
 * prorates", "`pos_close_table` is deliberately absent", "tendered and change
 * are never sent". A source assertion that searches the raw text cannot tell a
 * prose mention from the behaviour it describes, and would fail on a file that
 * is doing exactly the right thing and explaining why.
 *
 * NB the line-comment pattern. The obvious `/\/\/.*$/gm` does NOT work on this
 * repo's CRLF files: `.` stops at the `\r`, and `$` in multiline mode matches
 * only immediately before the `\n`, so nothing is stripped. `[^\r\n]*` is
 * line-ending agnostic, which is the whole point.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, "");
}

/** Same, plus JSX `{/* ... *​/}` blocks, which survive the plain block strip. */
export function stripJsxComments(source: string): string {
  return stripComments(source.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ""));
}
