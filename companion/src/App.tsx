import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
// Global shortcut removed — auto-respawn handles lost blobs instead
import {
  createBlobState,
  endDrag,
  isDragging,
  MonitorRect,
  BlobState,
  startDrag,
  stepBlob,
  updateDrag,
  setWindows,
} from "./canvas/physics";
import { drawFrame } from "./canvas/renderer";
import { isPointInPolygon } from "./canvas/hitTest";
import { useUsage } from "./hooks/useUsage";
import { useClickThrough } from "./hooks/useClickThrough";
import { useVisibleWindows } from "./hooks/useActiveWindow";

interface Bubble {
  text: string;
  opacity: number;
  timer: number;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const blobRef = useRef<BlobState | null>(null);
  const monitorsRef = useRef<MonitorRect[]>([]);
  const bubbleRef = useRef<Bubble | null>(null);
  const lastFrameRef = useRef(0);
  const usage = useUsage();

  const blobPosRef = useRef<{ nodes: { x: number; y: number; ox: number; oy: number }[] } | null>(null);
  useClickThrough(blobPosRef);

  const visibleWindows = useVisibleWindows();

  const lastAutoShow = useRef(0);

  const showBubble = useCallback((text: string, durationMs: number = 5000) => {
    if (bubbleRef.current) {
      clearTimeout(bubbleRef.current.timer);
    }
    const timer = window.setTimeout(() => {
      if (bubbleRef.current) {
        bubbleRef.current.opacity = 0;
        bubbleRef.current = null;
      }
    }, durationMs);
    bubbleRef.current = { text, opacity: 1, timer };
  }, []);

  // Fetch monitor geometries once on startup
  const [monitorsReady, setMonitorsReady] = useState(false);
  useEffect(() => {
    invoke<{ x: number; y: number; width: number; height: number }[]>(
      "get_monitors"
    ).then((rects) => {
      const dpr = window.devicePixelRatio || 1;
      monitorsRef.current = rects.map((r) => ({
        x: r.x / dpr,
        y: r.y / dpr,
        width: r.width / dpr,
        height: r.height / dpr,
      }));
      setMonitorsReady(true);
    }).catch(() => {
      monitorsRef.current = [{
        x: 0, y: 0,
        width: window.innerWidth,
        height: window.innerHeight,
      }];
      setMonitorsReady(true);
    });
  }, []);

  // Auto-respawn: if blob centroid is outside all monitors, reset it
  useEffect(() => {
    const id = window.setInterval(() => {
      const state = blobRef.current;
      if (!state || monitorsRef.current.length === 0) return;
      const { cx, cy } = state;
      const inSomeMonitor = monitorsRef.current.some(
        (m) => cx >= m.x - 200 && cx <= m.x + m.width + 200 &&
               cy >= m.y - 200 && cy <= m.y + m.height + 200
      );
      if (!inSomeMonitor) {
        const fresh = createBlobState(monitorsRef.current[0]);
        Object.assign(state, fresh);
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Update blob's visible windows when they change
  useEffect(() => {
    const state = blobRef.current;
    if (state) {
      setWindows(state, visibleWindows);
    }
  }, [visibleWindows]);

  // Animation loop
  useEffect(() => {
    if (!monitorsReady) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d")!;
    let running = true;

    function resize() {
      canvas!.width = window.innerWidth;
      canvas!.height = window.innerHeight;
      if (!blobRef.current && monitorsRef.current.length > 0) {
        blobRef.current = createBlobState(monitorsRef.current[0]);
      }
    }
    resize();
    window.addEventListener("resize", resize);

    function frame(now: number) {
      if (!running) return;
      const dt = Math.min((now - lastFrameRef.current) / 1000, 0.05);
      lastFrameRef.current = now;

      const state = blobRef.current!;
      stepBlob(state, dt, monitorsRef.current);

      blobPosRef.current = {
        nodes: state.nodes,
      };

      const sessionSection = usage.sections.find((s) => s.name === "Current session");
      const weeklySection = usage.sections.find((s) => s.name === "All models");
      drawFrame(ctx, state, {
        sessionPercent: sessionSection?.percent ?? usage.percent,
        weeklyPercent: weeklySection?.percent ?? usage.percent,
      }, bubbleRef.current);

      if (now - lastAutoShow.current > 300_000 && !usage.error) {
        lastAutoShow.current = now;
        showBubble(usage.label, 8000);
      }

      requestAnimationFrame(frame);
    }

    lastFrameRef.current = performance.now();
    lastAutoShow.current = performance.now();
    requestAnimationFrame(frame);

    return () => {
      running = false;
      window.removeEventListener("resize", resize);
    };
  }, [monitorsReady, usage.percent, usage.sections, usage.label, usage.error, showBubble]);

  // Mouse handlers — whole-blob spring drag
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const state = blobRef.current;
    if (!state) return;
    if (isPointInPolygon(e.clientX, e.clientY, state.nodes, 10)) {
      startDrag(state, e.clientX, e.clientY);
    }
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const state = blobRef.current;
    if (state && isDragging(state)) {
      updateDrag(state, e.clientX, e.clientY);
    }
  }, []);

  const handleMouseUp = useCallback(() => {
    const state = blobRef.current;
    if (state && isDragging(state)) {
      endDrag(state);
    }
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const state = blobRef.current;
      if (!state) return;
      if (isPointInPolygon(e.clientX, e.clientY, state.nodes, 10)) {
        if (usage.error) {
          showBubble('Run "claude auth"\nto connect', 5000);
        } else {
          const lines = [usage.planName, usage.label];
          for (const s of usage.sections) {
            if (s.name !== "Current session" && s.name !== "All models") {
              lines.push(`${s.name}: ${s.percent}%`);
            }
          }
          showBubble(lines.join("\n"), 5000);
        }
      }
    },
    [usage, showBubble]
  );

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        cursor: "default",
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onClick={handleClick}
    />
  );
}
