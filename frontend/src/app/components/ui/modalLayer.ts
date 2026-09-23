import type { CSSProperties } from 'react';

/**
 * Keeps a modal's content clickable when another modal is open behind it.
 *
 * ## The bug this exists for
 *
 * A workflow like Document Approval opens one dialog to confirm the action and
 * then a second to report the outcome. The second dialog appeared, the screen
 * dimmed, and its OK button did nothing — Esc was the only way out. The cause is
 * not a z-index conflict; it is Radix's `DismissableLayer` and *when* it
 * measures the stack.
 *
 * Every modal content is a DismissableLayer, and the library computes:
 *
 *   const highest = [...layersWithOutsidePointerEventsDisabled].slice(-1)[0];
 *   const index = layers.indexOf(node);
 *   const isPointerEventsEnabled = index >= layers.indexOf(highest);
 *   style={{ pointerEvents: isBodyPointerEventsDisabled
 *     ? (isPointerEventsEnabled ? 'auto' : 'none')
 *     : undefined }}
 *
 * `layers` is an insertion-ordered `Set`. A layer only receives
 * `pointer-events: auto` if it sits *at or above* the highest layer that
 * disables outside pointer events. When one dialog closes and another opens in
 * the same React commit, the outgoing layer's cleanup effect and the incoming
 * layer's mount effect both run — and the incoming one can be evaluated while
 * the outgoing node is still in the Set. The new dialog then computes `index`
 * below the dying layer, is treated as "not the top layer", and Radix inlines
 * `pointer-events: none` onto it:
 *
 *   · it still paints, so it looks like a working dialog;
 *   · Esc still closes it, because Escape is a document-level key handler and
 *     not a pointer event — which is why Esc appeared to work and nothing else
 *     did;
 *   · `onOpenChange` never fires from an outside click, so the overlay cannot
 *     be dismissed either.
 *
 * Radix spreads `...props.style` *after* its own computed value, so a value
 * passed here wins. That makes the pointer-events decision the app's rather than
 * the library's, and a dialog in this app can no longer be made inert by
 * whatever happens to be mounting or unmounting behind it.
 *
 * This is deliberately not a z-index change. Raising `z-index` would put the
 * dialog on top visually while leaving it inert — the same bug, harder to see.
 */
export const modalPointerGuard: CSSProperties = { pointerEvents: 'auto' };
