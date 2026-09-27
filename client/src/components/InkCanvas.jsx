/**
 * The drawing surface for التوقيع: ink drawn over one rendered page.
 *
 * ─── Controlled, because the strokes are not this component's business ──────
 *
 * The panel above owns `strokesByPage` — a stroke list per page — because it is
 * the one that flips pages, marks which pages carry ink, undoes the last
 * stroke, and finally exports every drawn page to a PNG. Keeping a second copy
 * of the strokes inside the canvas would mean the export and the picture could
 * disagree, which is the one bug this feature must not have: the person signs
 * what they see. So this component holds no stroke state at all. It draws the
 * list it is given, reports a finished stroke, and that is the whole contract.
 *
 * For the same reason `drawStrokes` is exported: the panel's offscreen export
 * canvas is drawn by this exact function, so the bytes sent to the server are
 * produced by the same code that produced the picture on screen. A second
 * drawing routine "just for the export" is how a signature ends up thicker,
 * smoother or offset in the stored PDF than it was on the glass.
 *
 * ─── Two coordinate spaces, measured late ───────────────────────────────────
 *
 * The backing store is the page image's natural size (`width` × `height`), the
 * resolution the server rendered and the resolution it expects back; the CSS
 * size is `displayWidth`, which zoom changes. devicePixelRatio is deliberately
 * NOT applied: the raster already is the resolution, and multiplying by the
 * screen's ratio would send the server an image it refuses.
 *
 * The scale between the two spaces is measured with `getBoundingClientRect()`
 * at pointerdown — never at mount. The document page mounts this panel inside a
 * `display:none` wrapper while another tab is open, where every measurement is
 * zero; a scale captured then would put every stroke at the origin or divide by
 * nothing. Measuring at the moment of the gesture also survives zooming,
 * scrolling and a resized window without a single listener.
 *
 * ─── Pointers, not touches or mice ──────────────────────────────────────────
 *
 * One pointer model covers pen, finger and mouse, and `setPointerCapture`
 * keeps a stroke attached to the canvas when the hand runs off its edge — the
 * ordinary case on a tablet, where the signature is bigger than the box. «رسم»
 * sets `touch-action: none` so the browser stops trying to pan the page while
 * the pen is down; «تحريك» hands scrolling and pinch-zoom back to the browser
 * and draws nothing. «القلم فقط» ignores `pointerType === 'touch'`, so the
 * palm resting on the glass leaves no mark.
 *
 * Drawing itself is a pointer gesture and has no keyboard equivalent; every
 * other control in this feature (page, undo, clear, save) is an ordinary
 * button, so nothing but the ink is unreachable without a pointer.
 */

import { useEffect, useRef } from 'react';

/** A point halfway between two, the control point chain quadratic smoothing needs. */
function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Draws one stroke in backing-store coordinates.
 *
 * Quadratic curves through the midpoints rather than straight lines between
 * samples: a pen reports a handful of points per centimetre, and joining them
 * with segments turns a signature into a polygon. Round caps and joins because
 * a signature is a pen nib, not a chisel.
 *
 * A stroke of one point is a deliberate dot (a full stop, the dot of a ن), and
 * a zero-length path strokes nothing at all — so it is filled as a disc.
 */
function drawStroke(ctx, stroke) {
  const points = stroke.points ?? [];
  if (points.length === 0) return;

  ctx.strokeStyle = stroke.colour;
  ctx.fillStyle = stroke.colour;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, Math.max(stroke.width / 2, 0.5), 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length - 1; index += 1) {
    const control = points[index];
    const end = midpoint(control, points[index + 1]);
    ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

/**
 * Draws a whole stroke list onto any 2D context.
 *
 * Exported for the panel's export canvas — see the header. The context is left
 * with the last stroke's style, which no caller depends on because every stroke
 * sets its own.
 */
export function drawStrokes(ctx, strokes) {
  for (const stroke of strokes ?? []) drawStroke(ctx, stroke);
}

/**
 * @param {object} props
 * @param {number} props.width         Backing store width — the page image's naturalWidth.
 * @param {number} props.height        Backing store height — the page image's naturalHeight.
 * @param {number} props.displayWidth  CSS width in pixels; the height follows the aspect ratio.
 * @param {Array}  props.strokes       The page's strokes: `{ colour, width, points }`.
 * @param {Function} props.onStrokesChange Called with the new list when a stroke ends.
 * @param {string} props.colour        Ink colour for the next stroke.
 * @param {number} props.lineWidth     Nib width in DISPLAYED pixels; scaled on the way in.
 * @param {'draw'|'pan'} props.mode
 * @param {boolean} props.penOnly      Ignore `pointerType === 'touch'`.
 * @param {boolean} [props.disabled]   Draws the list but accepts no new ink.
 */
export default function InkCanvas({
  width,
  height,
  displayWidth,
  strokes,
  onStrokesChange,
  colour,
  lineWidth,
  mode,
  penOnly,
  disabled = false,
}) {
  const canvasRef = useRef(null);
  /*
   * The stroke being drawn right now.
   *
   * It lives in a ref, not in state, because a pen reports up to 120 points a
   * second and a `setState` per point would re-render the whole panel that
   * often. The segment just drawn is painted straight onto the canvas; when the
   * pointer lifts, the finished stroke is handed to the parent exactly once and
   * the redraw effect below repaints the list — the same geometry, so nothing
   * moves at the handover.
   */
  const active = useRef(null);

  // Repaint whenever the list, the ink size or the page changes. Not while a
  // stroke is in flight: the props cannot change mid-stroke, and clearing the
  // canvas under a moving pen would erase the line being drawn.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawStrokes(ctx, strokes);
  }, [strokes, width, height]);

  /** Backing-store coordinates for a pointer event, using the rect of THIS gesture. */
  function toCanvas(event, rect, scale) {
    return {
      x: (event.clientX - rect.left) * scale,
      y: (event.clientY - rect.top) * scale,
    };
  }

  function onPointerDown(event) {
    if (disabled || mode !== 'draw') return;
    if (penOnly && event.pointerType === 'touch') return;
    // Mouse: the left button only. A right-click must stay a context menu.
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return; // Hidden tab: nothing measurable, nothing to draw.
    const scale = canvas.width / rect.width;

    event.preventDefault();
    // Keeps the stroke on this canvas even when the hand leaves it — the usual
    // case for a signature wider than the box.
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Capture is a convenience; a browser that refuses it still delivers the
      // moves while the pointer is over the canvas.
    }

    const point = toCanvas(event, rect, scale);
    active.current = {
      pointerId: event.pointerId,
      rect,
      scale,
      lastMid: point,
      stroke: { colour, width: Math.max(lineWidth * scale, 0.5), points: [point] },
    };

    // A tap with no movement must still leave a dot, so paint it immediately.
    const ctx = canvas.getContext('2d');
    if (ctx) drawStroke(ctx, active.current.stroke);
  }

  function onPointerMove(event) {
    const current = active.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;

    event.preventDefault();

    /*
     * Coalesced events are the pen's full sample rate; a browser that hands the
     * whole batch over produces a visibly smoother line than one point per
     * frame. Falling back to the event itself where the method is missing.
     */
    const samples = typeof event.getCoalescedEvents === 'function'
      ? (event.getCoalescedEvents() ?? [])
      : [];
    const batch = samples.length > 0 ? samples : [event];

    ctx.strokeStyle = current.stroke.colour;
    ctx.lineWidth = current.stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const sample of batch) {
      const point = toCanvas(sample, current.rect, current.scale);
      const previous = current.stroke.points[current.stroke.points.length - 1];
      // Samples closer than a backing-store pixel add nothing to the picture and
      // a great deal to the exported stroke list.
      if (Math.abs(point.x - previous.x) < 1 && Math.abs(point.y - previous.y) < 1) continue;

      const nextMid = midpoint(previous, point);
      // One short path per segment rather than re-stroking a growing one: the
      // geometry matches the full redraw's chain, and the cost stays flat over
      // a long signature.
      ctx.beginPath();
      ctx.moveTo(current.lastMid.x, current.lastMid.y);
      ctx.quadraticCurveTo(previous.x, previous.y, nextMid.x, nextMid.y);
      ctx.stroke();

      current.lastMid = nextMid;
      current.stroke.points.push(point);
    }
  }

  function finish(event) {
    const current = active.current;
    if (!current || current.pointerId !== event.pointerId) return;
    active.current = null;
    try {
      canvasRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // Already released — releasing a capture that has lapsed throws.
    }
    onStrokesChange?.([...(strokes ?? []), current.stroke]);
  }

  const ratio = width > 0 ? height / width : 1;
  const shown = Math.max(Math.round(displayWidth || 0), 1);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onContextMenu={(event) => {
        // A long press on a tablet opens the context menu in the middle of a
        // stroke; nothing here needs one.
        if (mode === 'draw') event.preventDefault();
      }}
      style={{
        width: shown,
        height: Math.max(Math.round(shown * ratio), 1),
        // The whole point of the mode switch: «رسم» takes the gesture away from
        // the browser, «تحريك» gives panning and pinch-zoom back.
        touchAction: mode === 'draw' && !disabled ? 'none' : 'pan-x pan-y pinch-zoom',
        cursor: disabled ? 'default' : mode === 'draw' ? 'crosshair' : 'grab',
      }}
      /*
        Physical left/top rather than `inset-0`: the canvas sits over the page
        image at its own size, and stretching it to the wrapper would decouple
        the two by whatever rounding the zoom left behind.
      */
      className="absolute left-0 top-0 select-none"
    />
  );
}
