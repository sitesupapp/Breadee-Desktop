// A QR symbol drawn from a matrix.
//
// THE SAME MATRIX THE PRINTER GETS. This never encodes anything; it renders a
// `QrMatrix` the caller already built, which is what makes the preview a
// prediction rather than an illustration.
//
// Drawn as an SVG of black rectangles, deliberately black-on-white rather than
// themed: the preview exists to approximate thermal paper, and a burgundy QR on
// a cream card would be a picture of a document nobody will ever hold. It also
// keeps the contrast a scanner needs whatever theme the terminal is running.

import type { QrMatrix } from "@/lib/pos/qrCode";

export function QrSymbol({ matrix, size = 96 }: { matrix: QrMatrix; size?: number }) {
  // One module of quiet zone in the viewBox on each side, which is what stops a
  // scanner failing to find the symbol's edges against the paper.
  const quiet = 2;
  const span = matrix.size + quiet * 2;
  const cells: string[] = [];
  for (let r = 0; r < matrix.size; r++) {
    const row = matrix.rows[r];
    for (let c = 0; c < matrix.size; c++) {
      if (row[c] === "1") cells.push(`M${c + quiet} ${r + quiet}h1v1h-1z`);
    }
  }
  return (
    <svg
      viewBox={`0 0 ${span} ${span}`}
      width={size}
      height={size}
      role="img"
      aria-label="Payment QR code"
      shapeRendering="crispEdges"
    >
      <rect width={span} height={span} fill="#ffffff" />
      <path d={cells.join("")} fill="#000000" />
    </svg>
  );
}
