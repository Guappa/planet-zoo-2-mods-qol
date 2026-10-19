// Where to put a floating card beside the element it explains (pure: no DOM).
// Gameface can report the size of a card it has just shown (it was
// display: none a moment ago) as 0 x 0 until the next layout, so callers pass
// the card's known minimum size and the measured size is only trusted when
// larger. The card goes right of the anchor unless it would run off the
// screen there, or the anchor is in the right half and the card fits left.
//   anchor: { left, right, top, bottom } (viewport px)
//   size:   { w, h } as measured (may be 0)
//   view:   { vw, vh }
//   opts:   { gap = 8, minW = 0, minH = 0 }
//   returns { left, top, side: 'right' | 'left' }
export function besideAnchor(anchor, size, view, opts = {}) {
    const gap = opts.gap != null ? opts.gap : 8;
    const vw = Math.max(1, Number(view && view.vw) || 1920);
    const vh = Math.max(1, Number(view && view.vh) || 1080);
    const w = Math.max(Number(size && size.w) || 0, Number(opts.minW) || 0);
    const hgt = Math.max(Number(size && size.h) || 0, Number(opts.minH) || 0);
    const aLeft = Number(anchor && anchor.left) || 0;
    const aRight = Number(anchor && anchor.right) || aLeft;
    const aTop = Number(anchor && anchor.top) || 0;
    const fitsRight = aRight + gap + w <= vw - gap;
    const fitsLeft = aLeft - gap - w >= gap;
    const pastMiddle = (aLeft + aRight) / 2 > vw / 2;
    const side = !fitsRight || (pastMiddle && fitsLeft) ? 'left' : 'right';
    let left = side === 'right' ? aRight + gap : aLeft - gap - w;
    // never off either edge (a card wider than the screen sticks to the left)
    left = Math.min(left, vw - gap - w);
    left = Math.max(gap, left);
    let top = aTop - 6;
    if (top + hgt > vh - gap) top = vh - gap - hgt;
    top = Math.max(gap, top);
    return { left: Math.round(left), top: Math.round(top), side };
}
