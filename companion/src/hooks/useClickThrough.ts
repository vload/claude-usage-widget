import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isPointInPolygon } from "../canvas/hitTest";
import type { BlobNode } from "../canvas/physics";

interface BlobPosition {
  nodes: BlobNode[];
}

export function useClickThrough(blobRef: React.RefObject<BlobPosition | null>) {
  const ignoring = useRef(true); // Rust sets WS_EX_TRANSPARENT at startup — we start click-through

  useEffect(() => {
    const appWindow = getCurrentWebviewWindow();
    let running = true;

    // WS_EX_TRANSPARENT is set from Rust at startup (before GlazeWM sees the window).
    // We only call setIgnoreCursorEvents(false) to make blob interactive on hover,
    // and setIgnoreCursorEvents(true) to restore click-through when cursor leaves.

    let unchangedCount = 0;
    let lastOverBlob = false;
    let currentInterval = 33;
    let intervalId: number;

    async function poll() {
      if (!running) return;

      try {
        const pos = await invoke<{ x: number; y: number }>("get_cursor_position");
        if (!running) return;

        const blob = blobRef.current;
        if (!blob || blob.nodes.length === 0) return;

        const dpr = window.devicePixelRatio || 1;
        const cx = pos.x / dpr;
        const cy = pos.y / dpr;

        const overBlob = isPointInPolygon(cx, cy, blob.nodes, 15);

        if (overBlob && ignoring.current) {
          await appWindow.setIgnoreCursorEvents(false);
          ignoring.current = false;
        } else if (!overBlob && !ignoring.current) {
          await appWindow.setIgnoreCursorEvents(true);
          ignoring.current = true;
        }

        if (overBlob === lastOverBlob) {
          unchangedCount++;
          const targetInterval = unchangedCount > 30 ? 500 : 33;
          if (targetInterval !== currentInterval) {
            currentInterval = targetInterval;
            clearInterval(intervalId);
            intervalId = window.setInterval(poll, currentInterval);
          }
        } else {
          unchangedCount = 0;
          if (currentInterval !== 33) {
            currentInterval = 33;
            clearInterval(intervalId);
            intervalId = window.setInterval(poll, currentInterval);
          }
        }
        lastOverBlob = overBlob;
      } catch {
        // Cursor position unavailable
      }
    }

    intervalId = window.setInterval(poll, currentInterval);

    return () => {
      running = false;
      clearInterval(intervalId);
    };
  }, [blobRef]);
}
