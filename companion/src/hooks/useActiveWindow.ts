import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface ActiveWindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Polls all visible windows every `intervalMs`. Returns DPR-adjusted rects. */
export function useVisibleWindows(intervalMs: number = 500): ActiveWindowRect[] {
  const [rects, setRects] = useState<ActiveWindowRect[]>([]);
  const running = useRef(true);

  useEffect(() => {
    running.current = true;

    async function poll() {
      if (!running.current) return;
      try {
        const result = await invoke<{
          x: number;
          y: number;
          width: number;
          height: number;
        }[]>("get_visible_window_rects");

        if (!running.current) return;

        const dpr = window.devicePixelRatio || 1;
        setRects(
          result.map((r) => ({
            x: r.x / dpr,
            y: r.y / dpr,
            width: r.width / dpr,
            height: r.height / dpr,
          }))
        );
      } catch {
        // Command unavailable or error
      }
    }

    poll();
    const id = window.setInterval(poll, intervalMs);
    return () => {
      running.current = false;
      clearInterval(id);
    };
  }, [intervalMs]);

  return rects;
}
