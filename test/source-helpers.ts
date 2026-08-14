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
  return source
    // WHOLE-LINE `//` COMMENTS FIRST, and this ordering is load-bearing.
    //
    // A line comment may legitimately contain a slash-star - `PosWorkspace.tsx`
    // line 3 says the rules live in "lib/pos/*" - and the block-comment pass
    // below cannot tell that from a real block opener. It would match from
    // there to the next real close, silently deleting every line in between.
    // Measured on `PosWorkspace.tsx`: several hundred lines vanished, including
    // the entire import block, which made "this file must not import
    // nativePrinting" pass against a string that no longer contained any
    // imports at all. An assertion that cannot fail is worse than no assertion,
    // because it is counted as coverage.
    //
    // Anchored to the start of the line (`^\s*//`) so a `//` inside a string -
    // a URL, most obviously - is never the thing that opens the match.
    .replace(/^[^\S\r\n]*\/\/[^\r\n]*(\r?\n)/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\r\n]*/g, "");
}

/**
 * Same, plus JSX `{/* ... *​/}` blocks, which survive the plain block strip.
 *
 * NB the braces are anchored TIGHT to the delimiters. An earlier `\{\s*\/\*`
 * would start matching at an ordinary object-literal brace followed by a JSDoc
 * block - `= {\n  /** ... ` - and, being lazy, run on until the next `*​/}`
 * anywhere below, deleting real code in between. Level 3A hit exactly that: a
 * type declaration and a whole render function vanished from a source assertion,
 * which then failed against a file that was correct. JSX comments in this repo
 * are always written `{/* ... *​/}` with no inner padding, so requiring it costs
 * nothing and removes the ambiguity.
 */
export function stripJsxComments(source: string): string {
  return stripComments(source.replace(/\{\/\*[\s\S]*?\*\/\}/g, ""));
}
