// Measure a DOM element (or the window) in CSS pixels.
//
// The POS layout is driven by measurement rather than media queries so Windows
// display scaling is handled correctly - see `src/lib/layout.ts`.

import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

export type Size = { width: number; height: number };

function windowSize(): Size {
  if (typeof window === "undefined") return { width: 1280, height: 800 };
  return { width: window.innerWidth, height: window.innerHeight };
}

/** Live window size in CSS px, updated on resize and on display-scale changes. */
export function useWindowSize(): Size {
  const [size, setSize] = useState<Size>(windowSize);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setSize(windowSize()));
    };
    window.addEventListener("resize", update);
    // A scale change fires no resize event on some Windows setups; the media
    // query on devicePixelRatio does fire, so listen to that too.
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener("change", update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      mq.removeEventListener("change", update);
    };
  }, []);
  return size;
}

/**
 * Live size of a specific element, via ResizeObserver.
 *
 * MEASURED SYNCHRONOUSLY ON MOUNT, THEN OBSERVED. The initial state is 0x0 -
 * there is nothing to measure before the element exists - and the layout effect
 * below replaces it with the real box BEFORE the browser paints. That matters
 * more than it looks: a consumer that decides something from the size would
 * otherwise decide it once from zero, and paint that decision for a frame. The
 * customized POS grid is exactly such a consumer, and the decision it would
 * paint is "this screen is too small" - across a cashier's screen, every time
 * the workspace opens.
 *
 * It also removes the dependency on ResizeObserver ever firing. It normally
 * fires once on `observe`, but an environment that is not producing frames does
 * not deliver the callback at all; the synchronous read is correct there too.
 */
export function useElementSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Only when it has one. Writing a zero here would be the same wrong answer
    // arrived at more expensively.
    if (rect.width > 0 || rect.height > 0) setSize({ width: rect.width, height: rect.height });
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ width: rect.width, height: rect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return size;
}
