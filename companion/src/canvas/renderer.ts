// ── Soft Gradient Blob Renderer ──────────────────────────────────────────

import type { BlobState } from "./physics";

interface SpeechBubble {
  text: string;
  opacity: number;
}

export interface UsageColors {
  sessionPercent: number; // 0-100, current session usage
  weeklyPercent: number;  // 0-100, "all models" weekly usage
}

/** Map a 0-100 usage percent to an RGB color: green → yellow → orange → red */
function usageToColor(percent: number): [number, number, number] {
  const p = Math.max(0, Math.min(100, percent));
  // 0%  = #4ade80 (green)
  // 40% = #facc15 (yellow)
  // 70% = #f97316 (orange)
  // 100% = #ef4444 (red)
  if (p <= 40) {
    const t = p / 40;
    return [
      Math.round(74 + (250 - 74) * t),
      Math.round(222 + (204 - 222) * t),
      Math.round(128 + (21 - 128) * t),
    ];
  } else if (p <= 70) {
    const t = (p - 40) / 30;
    return [
      Math.round(250 + (249 - 250) * t),
      Math.round(204 + (115 - 204) * t),
      Math.round(21 + (22 - 21) * t),
    ];
  } else {
    const t = (p - 70) / 30;
    return [
      Math.round(249 + (239 - 249) * t),
      Math.round(115 + (68 - 115) * t),
      Math.round(22 + (68 - 22) * t),
    ];
  }
}

/** Lighten a color toward white */
function lighten(rgb: [number, number, number], amount: number): [number, number, number] {
  return [
    Math.round(rgb[0] + (255 - rgb[0]) * amount),
    Math.round(rgb[1] + (255 - rgb[1]) * amount),
    Math.round(rgb[2] + (255 - rgb[2]) * amount),
  ];
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  state: BlobState,
  colors: UsageColors,
  bubble: SpeechBubble | null
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);

  const { nodes, cx, cy, radius } = state;
  const n = nodes.length;

  // ── Compute usage colors ──
  const sessionRgb = usageToColor(colors.sessionPercent);
  const weeklyRgb = usageToColor(colors.weeklyPercent);
  // Core = session color (lighter), rim = weekly color (darker)
  const coreRgb = lighten(sessionRgb, 0.35);
  const rimRgb = weeklyRgb;

  // ── Smooth blob path using Catmull-Rom-like curves ──
  const mids: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    mids.push({
      x: (nodes[i].x + nodes[j].x) / 2,
      y: (nodes[i].y + nodes[j].y) / 2,
    });
  }

  function traceBlobPath() {
    ctx.beginPath();
    ctx.moveTo(mids[0].x, mids[0].y);
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      ctx.quadraticCurveTo(nodes[next].x, nodes[next].y, mids[next].x, mids[next].y);
    }
    ctx.closePath();
  }

  // ── Shadow ──
  let maxY = -Infinity;
  for (const nd of nodes) {
    if (nd.y > maxY) maxY = nd.y;
  }
  ctx.save();
  const shadowY = maxY + 6;
  const shadowRx = radius * 1.1;
  const shadowRy = radius * 0.15;
  const shadowGrad = ctx.createRadialGradient(cx, shadowY, 0, cx, shadowY, shadowRx);
  shadowGrad.addColorStop(0, `rgba(${Math.round(rimRgb[0] * 0.3)}, ${Math.round(rimRgb[1] * 0.3)}, ${Math.round(rimRgb[2] * 0.3)}, 0.2)`);
  shadowGrad.addColorStop(0.6, `rgba(${Math.round(rimRgb[0] * 0.2)}, ${Math.round(rimRgb[1] * 0.2)}, ${Math.round(rimRgb[2] * 0.2)}, 0.08)`);
  shadowGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = shadowGrad;
  ctx.fillRect(cx - shadowRx, shadowY - shadowRy * 2, shadowRx * 2, shadowRy * 4);
  ctx.restore();

  // ── Outer glow (tinted with rim color) ──
  ctx.save();
  const glowR = radius * 1.6;
  const glowGrad = ctx.createRadialGradient(cx, cy, radius * 0.7, cx, cy, glowR);
  glowGrad.addColorStop(0, `rgba(${rimRgb[0]}, ${rimRgb[1]}, ${rimRgb[2]}, 0.12)`);
  glowGrad.addColorStop(0.5, `rgba(${rimRgb[0]}, ${rimRgb[1]}, ${rimRgb[2]}, 0.04)`);
  glowGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = glowGrad;
  ctx.fillRect(cx - glowR, cy - glowR, glowR * 2, glowR * 2);
  ctx.restore();

  // ── Main blob fill: radial gradient from session color (core) to weekly color (rim) ──
  ctx.save();
  traceBlobPath();

  const fillGrad = ctx.createRadialGradient(
    cx, cy - radius * 0.2, 0,
    cx, cy + radius * 0.15, radius * 1.1
  );
  fillGrad.addColorStop(0, `rgba(${coreRgb[0]}, ${coreRgb[1]}, ${coreRgb[2]}, 0.97)`);
  fillGrad.addColorStop(0.5, `rgba(${Math.round((coreRgb[0] + rimRgb[0]) / 2)}, ${Math.round((coreRgb[1] + rimRgb[1]) / 2)}, ${Math.round((coreRgb[2] + rimRgb[2]) / 2)}, 0.95)`);
  fillGrad.addColorStop(1, `rgba(${rimRgb[0]}, ${rimRgb[1]}, ${rimRgb[2]}, 0.92)`);

  ctx.shadowColor = `rgba(${Math.round(rimRgb[0] * 0.5)}, ${Math.round(rimRgb[1] * 0.5)}, ${Math.round(rimRgb[2] * 0.5)}, 0.2)`;
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = fillGrad;
  ctx.fill();
  ctx.restore();

  // ── Inner depth: bottom heavier (tinted) ──
  ctx.save();
  traceBlobPath();
  ctx.clip();

  const darkRim = [Math.round(rimRgb[0] * 0.7), Math.round(rimRgb[1] * 0.7), Math.round(rimRgb[2] * 0.7)];
  const depthGrad = ctx.createLinearGradient(cx, cy - radius, cx, cy + radius * 1.2);
  depthGrad.addColorStop(0, "rgba(255, 255, 255, 0)");
  depthGrad.addColorStop(0.5, "rgba(0, 0, 0, 0)");
  depthGrad.addColorStop(0.85, `rgba(${darkRim[0]}, ${darkRim[1]}, ${darkRim[2]}, 0.15)`);
  depthGrad.addColorStop(1, `rgba(${darkRim[0]}, ${darkRim[1]}, ${darkRim[2]}, 0.25)`);
  ctx.fillStyle = depthGrad;
  ctx.fillRect(cx - radius * 2, cy - radius * 2, radius * 4, radius * 4);
  ctx.restore();

  // ── Specular highlight (glossy spot, top-left) ──
  ctx.save();
  traceBlobPath();
  ctx.clip();

  const hlx = cx - radius * 0.2;
  const hly = cy - radius * 0.35;
  const hlr = radius * 0.55;
  const hlGrad = ctx.createRadialGradient(hlx, hly, 0, hlx, hly, hlr);
  hlGrad.addColorStop(0, "rgba(255, 255, 255, 0.65)");
  hlGrad.addColorStop(0.4, "rgba(255, 255, 255, 0.2)");
  hlGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = hlGrad;
  ctx.fillRect(cx - radius * 2, cy - radius * 2, radius * 4, radius * 4);
  ctx.restore();

  // ── Speech bubble ──
  if (bubble && bubble.opacity > 0) {
    const topY = nodes.reduce((min, nd) => Math.min(min, nd.y), Infinity);
    drawSpeechBubble(ctx, cx, topY - 12, bubble.text, bubble.opacity);
  }
}

// ── Speech bubble ────────────────────────────────────────────────────────

function drawSpeechBubble(
  ctx: CanvasRenderingContext2D,
  tipX: number,
  tipY: number,
  text: string,
  opacity: number
): void {
  ctx.save();
  ctx.globalAlpha = opacity;

  ctx.font = "13px sans-serif";
  const lines = text.split("\n");
  const lineHeight = 18;
  const padding = 10;
  let maxWidth = 0;
  for (const line of lines) {
    const m = ctx.measureText(line);
    if (m.width > maxWidth) maxWidth = m.width;
  }

  const boxW = maxWidth + padding * 2;
  const boxH = lines.length * lineHeight + padding * 2;
  const tailH = 8;

  let boxX = tipX - boxW / 2;
  let boxY = tipY - boxH - tailH;

  const canvasW = ctx.canvas.width;
  if (boxX < 8) boxX = 8;
  if (boxX + boxW > canvasW - 8) boxX = canvasW - 8 - boxW;
  if (boxY < 8) boxY = 8;

  const r = 8;
  ctx.beginPath();
  ctx.moveTo(boxX + r, boxY);
  ctx.lineTo(boxX + boxW - r, boxY);
  ctx.quadraticCurveTo(boxX + boxW, boxY, boxX + boxW, boxY + r);
  ctx.lineTo(boxX + boxW, boxY + boxH - r);
  ctx.quadraticCurveTo(boxX + boxW, boxY + boxH, boxX + boxW - r, boxY + boxH);

  const tailCx = Math.max(boxX + 15, Math.min(tipX, boxX + boxW - 15));
  ctx.lineTo(tailCx + 6, boxY + boxH);
  ctx.lineTo(tipX, tipY);
  ctx.lineTo(tailCx - 6, boxY + boxH);

  ctx.lineTo(boxX + r, boxY + boxH);
  ctx.quadraticCurveTo(boxX, boxY + boxH, boxX, boxY + boxH - r);
  ctx.lineTo(boxX, boxY + r);
  ctx.quadraticCurveTo(boxX, boxY, boxX + r, boxY);
  ctx.closePath();

  ctx.fillStyle = "rgba(30, 30, 30, 0.92)";
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.font = "13px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], boxX + padding, boxY + padding + i * lineHeight);
  }

  ctx.restore();
}
