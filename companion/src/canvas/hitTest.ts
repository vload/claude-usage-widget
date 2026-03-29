import type { BlobNode } from "./physics";

/** Ray-casting point-in-polygon test against the blob's perimeter nodes. */
export function isPointInPolygon(
  px: number,
  py: number,
  nodes: BlobNode[],
  padding: number = 0
): boolean {
  // If padding > 0, first do a rough bounding-box + padding check
  if (padding > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    if (
      px < minX - padding || px > maxX + padding ||
      py < minY - padding || py > maxY + padding
    ) {
      return false;
    }
  }

  // Expand polygon outward by padding for the actual test
  const testNodes = padding > 0 ? expandPolygon(nodes, padding) : nodes;

  let inside = false;
  const n = testNodes.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = testNodes[i].x, yi = testNodes[i].y;
    const xj = testNodes[j].x, yj = testNodes[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Expand polygon outward from centroid by `amount` pixels. */
function expandPolygon(nodes: BlobNode[], amount: number): { x: number; y: number }[] {
  let cx = 0, cy = 0;
  for (const n of nodes) { cx += n.x; cy += n.y; }
  cx /= nodes.length;
  cy /= nodes.length;

  return nodes.map((n) => {
    const dx = n.x - cx;
    const dy = n.y - cy;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    return {
      x: n.x + (dx / d) * amount,
      y: n.y + (dy / d) * amount,
    };
  });
}
