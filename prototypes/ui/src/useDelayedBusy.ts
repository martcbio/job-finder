import { useEffect, useRef, useState } from "react";

/** Show busy UI only after `delayMs`, and hold at least `minVisibleMs` once shown. */
export function useDelayedBusy(
  active: boolean,
  delayMs = 280,
  minVisibleMs = 320,
): boolean {
  const [visible, setVisible] = useState(false);
  const visibleRef = useRef(false);
  const shownAt = useRef(0);

  useEffect(() => {
    let delayTimer: ReturnType<typeof setTimeout> | undefined;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;

    if (active) {
      delayTimer = setTimeout(() => {
        shownAt.current = Date.now();
        visibleRef.current = true;
        setVisible(true);
      }, delayMs);
    } else if (visibleRef.current) {
      const elapsed = Date.now() - shownAt.current;
      const wait = Math.max(0, minVisibleMs - elapsed);
      hideTimer = setTimeout(() => {
        visibleRef.current = false;
        setVisible(false);
      }, wait);
    } else {
      setVisible(false);
    }

    return () => {
      clearTimeout(delayTimer);
      clearTimeout(hideTimer);
    };
  }, [active, delayMs, minVisibleMs]);

  return visible;
}
