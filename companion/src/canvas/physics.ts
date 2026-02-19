// ── Soft-Body Blob Physics (Verlet spring-mass + pressure) ──────────────

export interface MonitorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BlobNode {
  x: number;
  y: number;
  ox: number; // old x (Verlet)
  oy: number; // old y (Verlet)
}

export interface BlobSpring {
  a: number;
  b: number;
  restLength: number;
  stiffness: number;
}

export const enum MoveState {
  IDLE = 0,
  WALKING = 1,
  FLOATING = 2,
  DRAGGING = 3,
  FREE = 4,
}

export interface BlobState {
  nodes: BlobNode[];
  springs: BlobSpring[];
  cx: number;
  cy: number;
  radius: number;
  moveState: MoveState;
  // dragging
  dragX: number;
  dragY: number;
  prevDragX: number;
  prevDragY: number;
  grabNodeIdx: number;  // which node was grabbed
  grabOffsetX: number;  // cursor offset from centroid at grab time
  grabOffsetY: number;
  // walking
  walkDir: number;
  walkEdge: "top" | "bottom" | "left" | "right";
  walkSpeed: number;
  // floating
  targetX: number;
  targetY: number;
  floatTimer: number;
  // pressure
  targetPressure: number;
  // breathing
  breathPhase: number;
  // windows (all visible)
  windows: WindowRect[];
}

const NODE_COUNT = 14;
const DAMPING = 0.91;
const CONSTRAINT_ITERS = 2;
const PRESSURE_STRENGTH = 18;
const DEFAULT_PRESSURE = 1.0;
const GRAVITY = 120;
const WALK_SPEED = 50;
const FLOAT_SPEED = 80;
const FLOAT_DELAY = 5.0;
const BREATH_SPEED = 2.5;
const BREATH_AMOUNT = 0.08;
const BOUNCE_DECAY = 0.3;
const MAX_VELOCITY = 600;
const MAX_VELOCITY_FREE = 6000;
const REST_THRESHOLD = 1.5;
const ADHESION_STRENGTH = 0.12;
const ATTRACT_RANGE = 180;
const ATTRACT_STRENGTH = 0.4;

// ── Creation ─────────────────────────────────────────────────────────────

export function createBlobState(
  monitor: MonitorRect,
  radius: number = 28
): BlobState {
  const cx = monitor.x + monitor.width / 2;
  const cy = monitor.y + monitor.height - radius - 40;
  const nodes: BlobNode[] = [];

  for (let i = 0; i < NODE_COUNT; i++) {
    const angle = (i / NODE_COUNT) * Math.PI * 2;
    const nx = cx + Math.cos(angle) * radius;
    const ny = cy + Math.sin(angle) * radius;
    nodes.push({ x: nx, y: ny, ox: nx, oy: ny });
  }

  const springs: BlobSpring[] = [];

  for (let i = 0; i < NODE_COUNT; i++) {
    const j = (i + 1) % NODE_COUNT;
    springs.push({
      a: i, b: j,
      restLength: nodeDist(nodes[i], nodes[j]),
      stiffness: 0.1,       // edge springs — very soft outline
    });
  }

  for (let i = 0; i < NODE_COUNT; i++) {
    const j = (i + 2) % NODE_COUNT;
    springs.push({
      a: i, b: j,
      restLength: nodeDist(nodes[i], nodes[j]),
      stiffness: 0.03,     // skip springs — minimal structural rigidity
    });
  }

  for (let i = 0; i < NODE_COUNT / 2; i++) {
    const j = (i + Math.floor(NODE_COUNT / 2)) % NODE_COUNT;
    springs.push({
      a: i, b: j,
      restLength: nodeDist(nodes[i], nodes[j]),
      stiffness: 0.005,    // diameter springs — barely there, allows full squish
    });
  }

  return {
    nodes, springs, cx, cy, radius,
    moveState: MoveState.IDLE,
    dragX: 0, dragY: 0, prevDragX: 0, prevDragY: 0, grabNodeIdx: 0, grabOffsetX: 0, grabOffsetY: 0,
    walkDir: Math.random() < 0.5 ? 1 : -1,
    walkEdge: "top",
    walkSpeed: WALK_SPEED,
    targetX: cx, targetY: cy,
    floatTimer: 0,
    targetPressure: DEFAULT_PRESSURE,
    breathPhase: 0,
    windows: [],
  };
}

// ── Main step ────────────────────────────────────────────────────────────

export function stepBlob(
  state: BlobState,
  dt: number,
  monitors: MonitorRect[]
): void {
  if (monitors.length === 0) return;
  dt = Math.min(dt, 0.05);

  state.breathPhase += BREATH_SPEED * dt;
  const breathMod = 1.0 + Math.sin(state.breathPhase) * BREATH_AMOUNT;

  // Whether blob is clinging to a window edge (no gravity, adhesion instead)
  const clinging =
    (state.moveState === MoveState.WALKING || state.moveState === MoveState.IDLE) &&
    state.windows.length > 0;

  // ── Movement state logic ──
  switch (state.moveState) {
    case MoveState.DRAGGING:
      applyDragForces(state);
      break;
    case MoveState.FREE:
      state.floatTimer -= dt;
      if (state.floatTimer <= 0 && getKineticEnergy(state) < REST_THRESHOLD) {
        state.moveState = MoveState.FLOATING;
        state.floatTimer = 0;
        computeFloatTarget(state);
      }
      break;
    case MoveState.FLOATING:
      applyFloatForces(state, dt);
      break;
    case MoveState.WALKING:
      applyWalkForces(state, dt);
      break;
    case MoveState.IDLE:
      if (state.windows.length > 0 && Math.random() < 0.003) {
        state.moveState = MoveState.WALKING;
        state.walkDir = Math.random() < 0.5 ? 1 : -1;
      }
      break;
  }

  // ── Edge adhesion (replaces gravity when clinging) ──
  if (clinging) {
    applyEdgeAdhesion(state);
  }

  // ── Window attraction: all windows gently pull the blob ──
  if (!clinging && state.moveState !== MoveState.DRAGGING) {
    applyWindowAttraction(state, dt);
  }

  // ── Verlet integration ──
  for (let i = 0; i < NODE_COUNT; i++) {
    const n = state.nodes[i];
    let vx = (n.x - n.ox) * DAMPING;
    let vy = (n.y - n.oy) * DAMPING;

    // Cap velocity — higher limit when thrown freely
    const cap = state.moveState === MoveState.FREE ? MAX_VELOCITY_FREE : MAX_VELOCITY;
    const speed = Math.sqrt(vx * vx + vy * vy);
    if (speed > cap * dt) {
      const scale = (cap * dt) / speed;
      vx *= scale;
      vy *= scale;
    }

    n.ox = n.x;
    n.oy = n.y;
    n.x += vx;
    // Gravity only when NOT clinging to an edge
    n.y += vy + (clinging ? 0 : GRAVITY * dt * dt);
  }

  // ── Constraint iterations ──
  updateCentroid(state);
  const monitor =
    findContainingMonitor(state.cx, state.cy, monitors) ??
    findNearestMonitor(state.cx, state.cy, monitors);

  for (let iter = 0; iter < CONSTRAINT_ITERS; iter++) {
    for (const spring of state.springs) {
      relaxSpring(state.nodes, spring);
    }
    applyPressure(state, state.targetPressure * breathMod);
    // Cursor stick constraint (inside the loop so it resolves with walls)
    if (state.moveState === MoveState.DRAGGING) {
      applyCursorStickConstraint(state);
    }
    constrainWindowWalls(state);
    constrainToBounds(state, monitor);
  }

  // Hard safety clamp — no node may ever be outside the monitor after a frame
  hardClampToMonitor(state, monitor);

  updateCentroid(state);

  // Check if floating blob reached its target
  if (state.moveState === MoveState.FLOATING) {
    const dx = state.targetX - state.cx;
    const dy = state.targetY - state.cy;
    if (Math.sqrt(dx * dx + dy * dy) < 8) {
      state.moveState = MoveState.IDLE;
      snapToEdge(state);
    }
  }
}

// ── Drag ─────────────────────────────────────────────────────────────────
// Whole-blob spring pull toward cursor — no node pinning, no inversion.

const DRAG_SPRING_NEAR = 0.5;  // pull strength for nearest node
const DRAG_SPRING_FAR = 0.08;  // pull strength for farthest node
const DRAG_DAMP = 0.82;

export function startDrag(state: BlobState, mx: number, my: number): void {
  state.moveState = MoveState.DRAGGING;
  state.dragX = mx;
  state.dragY = my;
  state.prevDragX = mx;
  state.prevDragY = my;

  // Remember where on the blob the user clicked (offset from centroid)
  state.grabOffsetX = mx - state.cx;
  state.grabOffsetY = my - state.cy;

  // Find the nearest node to the grab point (for pinch effect)
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < state.nodes.length; i++) {
    const dx = state.nodes[i].x - mx;
    const dy = state.nodes[i].y - my;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  state.grabNodeIdx = bestIdx;

  // Soften velocity so blob doesn't fight the drag, but keep some for wobble
  for (const n of state.nodes) {
    n.ox = n.x - (n.x - n.ox) * 0.3;
    n.oy = n.y - (n.y - n.oy) * 0.3;
  }
}

export function updateDrag(state: BlobState, mx: number, my: number): void {
  state.prevDragX = state.dragX;
  state.prevDragY = state.dragY;
  state.dragX = mx;
  state.dragY = my;
}

export function endDrag(state: BlobState): void {
  // Transfer drag velocity to all nodes
  let throwVx = (state.dragX - state.prevDragX) * 8.0;
  let throwVy = (state.dragY - state.prevDragY) * 8.0;

  // Cap the initial throw so it can't escape the screen
  const throwSpeed = Math.sqrt(throwVx * throwVx + throwVy * throwVy);
  const maxThrow = 120; // max px displacement per frame
  if (throwSpeed > maxThrow) {
    const scale = maxThrow / throwSpeed;
    throwVx *= scale;
    throwVy *= scale;
  }

  for (const n of state.nodes) {
    n.ox = n.x - throwVx;
    n.oy = n.y - throwVy;
  }

  state.moveState = MoveState.FREE;
  state.floatTimer = FLOAT_DELAY;
}

export function isDragging(state: BlobState): boolean {
  return state.moveState === MoveState.DRAGGING;
}

// ── Edge targeting ───────────────────────────────────────────────────────

export function setWindows(
  state: BlobState,
  windows: WindowRect[]
): void {
  state.windows = windows;
  if (state.moveState === MoveState.IDLE || state.moveState === MoveState.WALKING) {
    const win = nearestWindow(state);
    if (win) computeFloatTarget(state);
  }
}

export function isIdle(state: BlobState): boolean {
  return (
    state.moveState === MoveState.IDLE ||
    state.moveState === MoveState.WALKING
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function nodeDist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function getKineticEnergy(state: BlobState): number {
  let energy = 0;
  for (const n of state.nodes) {
    const vx = n.x - n.ox;
    const vy = n.y - n.oy;
    energy += vx * vx + vy * vy;
  }
  return energy / NODE_COUNT;
}

function updateCentroid(state: BlobState): void {
  let sx = 0, sy = 0;
  for (const n of state.nodes) { sx += n.x; sy += n.y; }
  state.cx = sx / NODE_COUNT;
  state.cy = sy / NODE_COUNT;
}

/** Find the window closest to the blob centroid. */
function nearestWindow(state: BlobState): WindowRect | null {
  if (state.windows.length === 0) return null;
  let best = state.windows[0];
  let bestDist = Infinity;
  for (const w of state.windows) {
    // Distance from centroid to nearest point on window rect
    const cx = Math.max(w.x, Math.min(state.cx, w.x + w.width));
    const cy = Math.max(w.y, Math.min(state.cy, w.y + w.height));
    const d = (cx - state.cx) ** 2 + (cy - state.cy) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = w;
    }
  }
  return best;
}

function relaxSpring(nodes: BlobNode[], spring: BlobSpring): void {
  const a = nodes[spring.a];
  const b = nodes[spring.b];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.sqrt(dx * dx + dy * dy) || 0.001;
  const diff = (d - spring.restLength) / d;
  const move = diff * spring.stiffness * 0.5;
  const mx = dx * move;
  const my = dy * move;
  a.x += mx;
  a.y += my;
  b.x -= mx;
  b.y -= my;
}

function polygonArea(nodes: BlobNode[]): number {
  let area = 0;
  const n = nodes.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += nodes[i].x * nodes[j].y;
    area -= nodes[j].x * nodes[i].y;
  }
  return Math.abs(area) / 2;
}

function applyPressure(state: BlobState, pressure: number): void {
  const area = polygonArea(state.nodes) || 1;
  const force = (PRESSURE_STRENGTH * pressure) / area;
  const n = state.nodes.length;

  for (let i = 0; i < n; i++) {
    const prev = state.nodes[(i - 1 + n) % n];
    const next = state.nodes[(i + 1) % n];
    const ex = next.x - prev.x;
    const ey = next.y - prev.y;
    const nx = -ey * force;
    const ny = ex * force;
    state.nodes[i].x += nx;
    state.nodes[i].y += ny;
  }
}

// ── Collision: keep nodes INSIDE monitor bounds ──

function constrainToBounds(state: BlobState, monitor: MonitorRect): void {
  const left = monitor.x;
  const right = monitor.x + monitor.width;
  const top = monitor.y;
  const bottom = monitor.y + monitor.height;

  for (const node of state.nodes) {
    if (node.x < left) {
      const vx = node.x - node.ox;
      node.x = left;
      // Clamp ox within bounds so reflected velocity ≤ monitor width
      node.ox = Math.min(right, left - vx * BOUNCE_DECAY);
    } else if (node.x > right) {
      const vx = node.x - node.ox;
      node.x = right;
      node.ox = Math.max(left, right - vx * BOUNCE_DECAY);
    }

    if (node.y < top) {
      const vy = node.y - node.oy;
      node.y = top;
      node.oy = Math.min(bottom, top - vy * BOUNCE_DECAY);
    } else if (node.y > bottom) {
      const vy = node.y - node.oy;
      node.y = bottom;
      node.oy = Math.max(top, bottom - vy * BOUNCE_DECAY);
    }
  }
}

/** Absolute safety net — clamp every node + its old position inside the monitor. */
function hardClampToMonitor(state: BlobState, monitor: MonitorRect): void {
  const left = monitor.x;
  const right = monitor.x + monitor.width;
  const top = monitor.y;
  const bottom = monitor.y + monitor.height;

  for (const node of state.nodes) {
    if (node.x < left || node.x > right || node.y < top || node.y > bottom) {
      node.x = Math.max(left, Math.min(node.x, right));
      node.y = Math.max(top, Math.min(node.y, bottom));
      node.ox = Math.max(left, Math.min(node.ox, right));
      node.oy = Math.max(top, Math.min(node.oy, bottom));
    }
  }
}

// ── Window walls: edges are solid from both sides ──
// If centroid is INSIDE a window → bounce off inner walls (stay inside)
// If centroid is OUTSIDE a window → push nodes out (can't enter)

function constrainWindowWalls(state: BlobState): void {
  for (const win of state.windows) {
    const left = win.x;
    const right = win.x + win.width;
    const top = win.y;
    const bottom = win.y + win.height;

    const centroidInside =
      state.cx > left && state.cx < right &&
      state.cy > top && state.cy < bottom;

    if (centroidInside) {
      // Blob is inside this window — hard bounce off inner walls
      for (const node of state.nodes) {
        if (node.x < left) {
          const vx = node.x - node.ox;
          node.x = left;
          node.ox = Math.min(right, left - vx * BOUNCE_DECAY);
        } else if (node.x > right) {
          const vx = node.x - node.ox;
          node.x = right;
          node.ox = Math.max(left, right - vx * BOUNCE_DECAY);
        }
        if (node.y < top) {
          const vy = node.y - node.oy;
          node.y = top;
          node.oy = Math.min(bottom, top - vy * BOUNCE_DECAY);
        } else if (node.y > bottom) {
          const vy = node.y - node.oy;
          node.y = bottom;
          node.oy = Math.max(top, bottom - vy * BOUNCE_DECAY);
        }
      }
    } else {
      // Blob is outside this window — hard push overlapping nodes out with bounce
      for (const node of state.nodes) {
        if (node.x <= left || node.x >= right || node.y <= top || node.y >= bottom) continue;

        // Node is inside the window — snap to nearest edge with velocity reflection
        const dL = node.x - left;
        const dR = right - node.x;
        const dT = node.y - top;
        const dB = bottom - node.y;
        const minD = Math.min(dL, dR, dT, dB);

        if (minD === dT) {
          const vy = node.y - node.oy;
          node.y = top;
          node.oy = top + vy * BOUNCE_DECAY;
        } else if (minD === dB) {
          const vy = node.y - node.oy;
          node.y = bottom;
          node.oy = bottom + vy * BOUNCE_DECAY;
        } else if (minD === dL) {
          const vx = node.x - node.ox;
          node.x = left;
          node.ox = left + vx * BOUNCE_DECAY;
        } else {
          const vx = node.x - node.ox;
          node.x = right;
          node.ox = right + vx * BOUNCE_DECAY;
        }
      }
    }
  }
}

// ── Edge adhesion: gently pull blob toward the window surface ──

function applyEdgeAdhesion(state: BlobState): void {
  const win = nearestWindow(state);
  if (!win) return;

  const r = state.radius;
  let targetX = state.cx;
  let targetY = state.cy;

  // Target position: centroid just outside the window edge
  switch (state.walkEdge) {
    case "top":
      targetY = win.y - r * 0.6;
      targetX = Math.max(win.x + r, Math.min(state.cx, win.x + win.width - r));
      break;
    case "bottom":
      targetY = win.y + win.height + r * 0.6;
      targetX = Math.max(win.x + r, Math.min(state.cx, win.x + win.width - r));
      break;
    case "left":
      targetX = win.x - r * 0.6;
      targetY = Math.max(win.y + r, Math.min(state.cy, win.y + win.height - r));
      break;
    case "right":
      targetX = win.x + win.width + r * 0.6;
      targetY = Math.max(win.y + r, Math.min(state.cy, win.y + win.height - r));
      break;
  }

  const dx = (targetX - state.cx) * ADHESION_STRENGTH;
  const dy = (targetY - state.cy) * ADHESION_STRENGTH;

  for (const n of state.nodes) {
    n.x += dx;
    n.y += dy;
    n.ox += dx;
    n.oy += dy;
  }
}

/** All visible windows gently pull the blob toward their nearest edge. */
function applyWindowAttraction(state: BlobState, dt: number): void {
  let totalFx = 0;
  let totalFy = 0;

  for (const win of state.windows) {
    // Nearest point on window rect to the blob centroid
    const nx = Math.max(win.x, Math.min(state.cx, win.x + win.width));
    const ny = Math.max(win.y, Math.min(state.cy, win.y + win.height));
    const dx = nx - state.cx;
    const dy = ny - state.cy;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 1 || dist > ATTRACT_RANGE) continue;

    // Strength falls off linearly with distance
    const strength = ATTRACT_STRENGTH * (1 - dist / ATTRACT_RANGE) * dt;
    totalFx += (dx / dist) * strength;
    totalFy += (dy / dist) * strength;
  }

  if (totalFx === 0 && totalFy === 0) return;

  for (const n of state.nodes) {
    n.x += totalFx;
    n.y += totalFy;
  }
}

const STICK_RADIUS = 3;

function applyDragForces(state: BlobState): void {
  // Elastic centroid follow — blob follows cursor with some lag (jelly drag).
  // Only apply when cursor is actually moving — when still, gravity takes over
  // so the blob falls and drapes over the cursor like a membrane.
  const targetCx = state.dragX - state.grabOffsetX;
  const targetCy = state.dragY - state.grabOffsetY;

  const cursorDx = state.dragX - state.prevDragX;
  const cursorDy = state.dragY - state.prevDragY;
  const cursorSpeed = Math.sqrt(cursorDx * cursorDx + cursorDy * cursorDy);

  // Reset prev so next frame reads 0 speed if no mouse event fires
  state.prevDragX = state.dragX;
  state.prevDragY = state.dragY;

  // Ramp follow strength based on cursor speed: 0 when still, full at speed >= 5px
  const followStrength = Math.min(cursorSpeed / 5, 1) * 0.12;

  const dx = (targetCx - state.cx) * followStrength;
  const dy = (targetCy - state.cy) * followStrength;

  for (const n of state.nodes) {
    n.x += dx;
    n.y += dy;
  }
}

/** Stick-in-a-bag constraint. The cursor defines a minimum distance from centroid
 *  in its angular direction. Nodes in that region get pushed outward.
 *  Position-based, so it can't tunnel no matter how fast the cursor moves. */
function applyCursorStickConstraint(state: BlobState): void {
  const cx = state.cx;
  const cy = state.cy;

  // Cursor position relative to centroid
  const relX = state.dragX - cx;
  const relY = state.dragY - cy;
  const cursorDist = Math.sqrt(relX * relX + relY * relY);

  if (cursorDist < 1) return; // cursor at center, nothing to push

  const cursorDirX = relX / cursorDist;
  const cursorDirY = relY / cursorDist;

  for (const n of state.nodes) {
    const ndx = n.x - cx;
    const ndy = n.y - cy;
    const nodeDist = Math.sqrt(ndx * ndx + ndy * ndy) || 0.001;
    const nodeDirX = ndx / nodeDist;
    const nodeDirY = ndy / nodeDist;

    // Angular proximity: how much this node faces the cursor direction
    const dot = nodeDirX * cursorDirX + nodeDirY * cursorDirY;
    if (dot <= 0) continue; // node is on the opposite side, skip

    // Smooth angular falloff (concentrated around cursor direction)
    const angular = dot * dot * dot * dot * dot; // pow5 = very narrow cone, like a fingertip

    // Minimum distance this node should be from centroid
    const minDist = (cursorDist + STICK_RADIUS) * angular;

    if (nodeDist < minDist) {
      // Push node outward — strong enough for visible stretch
      const push = (minDist - nodeDist) * 0.8;
      n.x += nodeDirX * push;
      n.y += nodeDirY * push;
    }
  }
}

function applyWalkForces(state: BlobState, dt: number): void {
  const win = nearestWindow(state);
  if (!win) {
    state.moveState = MoveState.IDLE;
    return;
  }

  const speed = state.walkSpeed * state.walkDir * dt;
  const prevEdge = state.walkEdge;

  switch (prevEdge) {
    case "top":
    case "bottom": {
      for (const n of state.nodes) { n.x += speed; n.ox += speed; }
      updateCentroid(state);
      // Corner transitions: wrap around to adjacent edge
      if (state.cx < win.x + state.radius) {
        state.walkEdge = "left";
        state.walkDir = prevEdge === "top" ? 1 : -1;
      } else if (state.cx > win.x + win.width - state.radius) {
        state.walkEdge = "right";
        state.walkDir = prevEdge === "top" ? -1 : 1;
      }
      break;
    }
    case "left":
    case "right": {
      for (const n of state.nodes) { n.y += speed; n.oy += speed; }
      updateCentroid(state);
      if (state.cy < win.y + state.radius) {
        state.walkEdge = "top";
        state.walkDir = prevEdge === "left" ? 1 : -1;
      } else if (state.cy > win.y + win.height - state.radius) {
        state.walkEdge = "bottom";
        state.walkDir = prevEdge === "left" ? -1 : 1;
      }
      break;
    }
  }

  if (Math.random() < 0.002) {
    state.moveState = MoveState.IDLE;
  }
}

function applyFloatForces(state: BlobState, dt: number): void {
  const dx = state.targetX - state.cx;
  const dy = state.targetY - state.cy;
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  const speed = Math.min(FLOAT_SPEED * dt, d);
  const mx = (dx / d) * speed;
  const my = (dy / d) * speed;

  for (const n of state.nodes) {
    n.x += mx;
    n.y += my;
    n.ox += mx;
    n.oy += my;
  }
}

// Float/snap targets are now OUTSIDE the window (blob sits on the surface)

function computeFloatTarget(state: BlobState): void {
  const win = nearestWindow(state);
  if (!win) return;

  const cx = state.cx;
  const cy = state.cy;
  const r = state.radius;

  // Targets just outside each window edge
  const candidates: { x: number; y: number; edge: typeof state.walkEdge }[] = [
    { x: cx, y: win.y - r, edge: "top" },                    // above window
    { x: cx, y: win.y + win.height + r, edge: "bottom" },    // below window
    { x: win.x - r, y: cy, edge: "left" },                   // left of window
    { x: win.x + win.width + r, y: cy, edge: "right" },      // right of window
  ];

  // Clamp along the window extent
  for (const c of candidates) {
    if (c.edge === "top" || c.edge === "bottom") {
      c.x = Math.max(win.x + r, Math.min(c.x, win.x + win.width - r));
    } else {
      c.y = Math.max(win.y + r, Math.min(c.y, win.y + win.height - r));
    }
  }

  let best = candidates[0];
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = (c.x - cx) ** 2 + (c.y - cy) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }

  state.targetX = best.x;
  state.targetY = best.y;
  state.walkEdge = best.edge;
}

function snapToEdge(state: BlobState): void {
  const win = nearestWindow(state);
  if (!win) return;

  const r = state.radius;
  let targetX = state.cx;
  let targetY = state.cy;

  switch (state.walkEdge) {
    case "top":
      targetY = win.y - r * 0.6;
      break;
    case "bottom":
      targetY = win.y + win.height + r * 0.6;
      break;
    case "left":
      targetX = win.x - r * 0.6;
      break;
    case "right":
      targetX = win.x + win.width + r * 0.6;
      break;
  }

  const dx = targetX - state.cx;
  const dy = targetY - state.cy;
  for (const n of state.nodes) {
    n.x += dx;
    n.y += dy;
    n.ox += dx;
    n.oy += dy;
  }
  updateCentroid(state);
}

function findContainingMonitor(
  x: number, y: number, monitors: MonitorRect[]
): MonitorRect | null {
  for (const m of monitors) {
    if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) {
      return m;
    }
  }
  return null;
}

function findNearestMonitor(
  x: number, y: number, monitors: MonitorRect[]
): MonitorRect {
  let nearest = monitors[0];
  let minDist = Infinity;
  for (const m of monitors) {
    const cx = Math.max(m.x, Math.min(x, m.x + m.width));
    const cy = Math.max(m.y, Math.min(y, m.y + m.height));
    const d = (cx - x) ** 2 + (cy - y) ** 2;
    if (d < minDist) {
      minDist = d;
      nearest = m;
    }
  }
  return nearest;
}
