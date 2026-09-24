import { useCallback, useEffect, useRef, useState } from 'react';
import { Eraser, PenLine, Redo2, Trash2, Upload } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/dialog';
import { Button } from '@/app/components/ui/button';

/**
 * Draw-a-signature field.
 *
 * The signer draws freehand inside the box with a mouse, finger or pen. The pad
 * emits a PNG data URL through `onChange`, which the caller stores on the record
 * it belongs to.
 *
 * Pointer Events are used rather than mouse events so a mouse, a stylus and a
 * touch screen all work through one code path; `touch-none` stops the browser
 * scrolling the page instead of drawing.
 *
 * A saved signature is restored by drawing it into the canvas as a base layer,
 * so re-opening a record shows what was signed. New strokes are layered on top
 * of that base, and both are re-rendered from scratch on Clear/Redo — the canvas
 * is never trusted as the source of truth.
 */
interface SignaturePadProps {
  /** Saved signature as a PNG data URL, or empty/undefined when unsigned. */
  value?: string | null;
  /** Receives the PNG data URL, or `''` when the pad is empty. */
  onChange: (value: string) => void;
  /** Render read-only: the signature is shown but cannot be changed. */
  disabled?: boolean;
  /** Accessible name, e.g. "Houseparent on Duty signature". */
  label: string;
  /** Backing-store size. CSS scales it, so this only controls fidelity. */
  width?: number;
  height?: number;
  className?: string;
  /**
   * Fill the parent box instead of stacking canvas-over-buttons. Used when the
   * pad is laid directly over the signature line of a printed form, where the
   * available space is exactly the size of the line.
   */
  compact?: boolean;
  /** Placeholder shown in `compact` mode while the pad is still empty. */
  hint?: string;
}

type Point = { x: number; y: number };

const STROKE_WIDTH = 2;
const STROKE_COLOUR = '#1f2937';

/** Largest upload accepted, before it is normalised. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Turns an uploaded image into the same PNG data URL the pad draws.
 *
 * Uploading is offered alongside drawing so a signer who already has a scan or a
 * photo of their signature on file does not have to re-draw it with a mouse.
 *
 * The image is redrawn into a canvas of the pad's own proportions rather than
 * stored as it arrived. Three things depend on that:
 *
 *   - the stored value stays a PNG data URL, so the PDF stamp and the on-screen
 *     preview need no second code path;
 *   - every signature is base64 inside a LONGTEXT column, and base64 is about a
 *     third larger than the file it encodes. A phone photo of a signature is
 *     megabytes, and the database is the free tier's binding constraint, so an
 *     un-resized original would sit there for the life of the record;
 *   - EXIF and anything else embedded in the original is dropped on the way
 *     through, because the pixels are redrawn rather than copied.
 *
 * SVG is refused outright: it is the one image format that can carry script, and
 * nothing here needs it.
 */
async function imageFileToSignaturePng(file: File, width: number, height: number): Promise<string> {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') {
    throw new Error('Choose a PNG or JPEG image of the signature.');
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error('That image is larger than 8 MB. Choose a smaller one.');
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.readAsDataURL(file);
  });

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const loaded = new Image();
    loaded.onload = () => resolve(loaded);
    loaded.onerror = () => reject(new Error('That file is not an image this browser can read.'));
    loaded.src = dataUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot process the image.');

  // Contain rather than stretch: a signature that arrived portrait must not be
  // squashed into the pad's landscape box.
  const scale = Math.min(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  context.drawImage(
    image,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );

  return canvas.toDataURL('image/png');
}

export function SignaturePad({
  value,
  onChange,
  disabled = false,
  label,
  width = 260,
  height = 80,
  className = '',
  compact = false,
  hint,
}: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Strokes drawn in this session, on top of `baseRef`. */
  const strokesRef = useRef<Point[][]>([]);
  /** The saved signature loaded from the record, if any. */
  const baseRef = useRef<HTMLImageElement | null>(null);
  /** What Clear threw away, so Redo can put it back. */
  const redoRef = useRef<{ base: HTMLImageElement | null; strokes: Point[][] } | null>(null);
  const drawingRef = useRef(false);
  /**
   * The last value this pad emitted. Lets the sync effect tell "the parent
   * re-rendered our own value" apart from "a different record was loaded", so
   * restoring a saved signature never wipes strokes the user just drew.
   */
  const emittedRef = useRef<string>(value || '');
  // Refs do not re-render, so the two things the buttons depend on are mirrored
  // into state. Without this Clear would leave Redo greyed out forever.
  const [hasContent, setHasContent] = useState<boolean>(Boolean(value));
  const [canRedo, setCanRedo] = useState(false);

  /** Repaints the canvas from `baseRef` + `strokesRef`. */
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    context.clearRect(0, 0, canvas.width, canvas.height);
    if (baseRef.current) {
      context.drawImage(baseRef.current, 0, 0, canvas.width, canvas.height);
    }

    context.lineWidth = STROKE_WIDTH;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = STROKE_COLOUR;

    for (const stroke of strokesRef.current) {
      if (stroke.length === 0) continue;
      context.beginPath();
      context.moveTo(stroke[0].x, stroke[0].y);
      for (const point of stroke.slice(1)) context.lineTo(point.x, point.y);
      // A single tap is still a mark, so give it a zero-length segment to stroke.
      if (stroke.length === 1) context.lineTo(stroke[0].x + 0.01, stroke[0].y);
      context.stroke();
    }
  }, []);

  /** Publishes the current canvas as a PNG data URL, or `''` when nothing is drawn. */
  const emit = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const empty = strokesRef.current.length === 0 && !baseRef.current;
    const next = empty ? '' : canvas.toDataURL('image/png');
    emittedRef.current = next;
    setHasContent(!empty);
    onChange(next);
  }, [onChange]);

  /**
   * Loads a value that came from the record rather than from this pad.
   * Our own emissions are ignored so drawing is never interrupted.
   */
  useEffect(() => {
    const incoming = value || '';
    if (incoming === emittedRef.current) return;
    emittedRef.current = incoming;

    strokesRef.current = [];
    redoRef.current = null;
    baseRef.current = null;
    setCanRedo(false);
    setHasContent(Boolean(incoming));

    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!incoming) return;

    const image = new Image();
    image.onload = () => {
      baseRef.current = image;
      redraw();
    };
    image.src = incoming;
  }, [value, redraw]);

  /** Converts a pointer position into canvas backing-store coordinates. */
  const toCanvasPoint = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * canvas.width) / rect.width,
      y: ((event.clientY - rect.top) * canvas.height) / rect.height,
    };
  };

  const start = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    canvas.setPointerCapture(event.pointerId);
    const point = toCanvasPoint(event);
    strokesRef.current.push([point]);
    drawingRef.current = true;

    context.lineWidth = STROKE_WIDTH;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = STROKE_COLOUR;
    context.beginPath();
    context.moveTo(point.x, point.y);
  };

  const draw = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || disabled) return;
    const context = canvasRef.current?.getContext('2d');
    if (!context) return;
    const point = toCanvasPoint(event);
    strokesRef.current[strokesRef.current.length - 1].push(point);
    context.lineTo(point.x, point.y);
    context.stroke();
  };

  const stop = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    emit();
  };

  /** Wipes the pad, remembering what was there so Redo can restore it. */
  const clear = () => {
    if (disabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const hadSomething = strokesRef.current.length > 0 || !!baseRef.current;
    redoRef.current = hadSomething
      ? { base: baseRef.current, strokes: strokesRef.current.map(stroke => [...stroke]) }
      : null;
    baseRef.current = null;
    strokesRef.current = [];
    setCanRedo(hadSomething);
    redraw();
    emit();
  };

  /** Restores the signature Clear removed. */
  const redo = () => {
    if (disabled) return;
    const saved = redoRef.current;
    if (!saved) return;
    redoRef.current = null;
    baseRef.current = saved.base;
    strokesRef.current = saved.strokes.map(stroke => [...stroke]);
    setCanRedo(false);
    redraw();
    emit();
  };

  const buttonClass =
    'inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

  /*
   * In compact mode the pad is only as big as the form's signature line, so the
   * buttons drop their icons and tighten up — two full-size buttons would cover
   * most of a short box. They are hover-only and translucent either way.
   */
  const compactButtonClass =
    'inline-flex items-center text-[9px] font-semibold px-1.5 py-px rounded border border-gray-300 text-gray-700 bg-white/90 shadow-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

  const canvasClass = compact
    ? [
        'h-full w-full touch-none rounded-sm',
        'border border-dashed border-gray-300/80 bg-transparent',
        disabled ? 'cursor-not-allowed opacity-70' : 'cursor-crosshair',
      ].join(' ')
    : [
        'w-full touch-none border border-dashed border-gray-400 bg-white',
        disabled ? 'cursor-not-allowed opacity-70' : 'cursor-crosshair',
      ].join(' ');

  const buttons = (
    <div
      className={
        compact
          ? 'absolute right-0.5 top-0.5 z-10 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100'
          : 'flex items-center gap-1.5'
      }
    >
      <button
        type="button"
        onClick={clear}
        disabled={disabled || !hasContent}
        className={compact ? compactButtonClass : `${buttonClass} border-gray-300 text-gray-700 hover:bg-gray-50`}
        title="Erase the signature"
      >
        {compact ? 'Clear' : <><Eraser className="w-3 h-3" /> Clear</>}
      </button>
      <button
        type="button"
        onClick={redo}
        disabled={disabled || !canRedo}
        className={compact ? compactButtonClass : `${buttonClass} border-gray-300 text-gray-700 hover:bg-gray-50`}
        title="Restore the cleared signature"
      >
        {compact ? 'Redo' : <><Redo2 className="w-3 h-3" /> Redo</>}
      </button>
    </div>
  );

  return (
    <div className={compact ? `group relative h-full w-full ${className}` : `space-y-1 ${className}`}>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        onPointerDown={start}
        onPointerMove={draw}
        onPointerUp={stop}
        onPointerCancel={stop}
        aria-label={label}
        role="img"
        className={canvasClass}
        /*
          On a phone a 1000x300 backing store scaled to the viewport width
          collapses to a strip roughly 90px tall, which is not enough room to
          write a signature legibly — the drawn stroke ends up thicker than the
          space between the lines of the form. Give the canvas an aspect-ratio
          box instead of a fixed height: it stays 3:1 where there is width for
          it, and grows taller in portrait where the width is scarce. The
          backing store is untouched, so the emitted PNG is identical.
        */
        style={
          compact
            ? undefined
            : { height, aspectRatio: `${width} / ${Math.max(height, 220)}`, maxHeight: '60vh' }
        }
      />


      {compact && hint && !hasContent && !disabled && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[9px] font-semibold text-gray-400">
          {hint}
        </span>
      )}

      {buttons}
    </div>
  );
}

export default SignaturePad;

/**
 * A signature field that opens a full-size signing surface in a modal.
 *
 * The Admission Slip and the Quarterly Progress Report both reserve a signature
 * band that is only a few millimetres tall on the printed page. Laying a canvas
 * directly in that band technically works with a mouse and is unusable on a
 * phone — the drawing area is a sliver, and Clear/Redo sit on top of it. This
 * renders the band as a trigger instead: it shows the saved signature (or a
 * "Sign here" hint) and opens a large canvas to draw in.
 *
 * The emitted value is a PNG data URL, exactly as {@link SignaturePad} produces,
 * so nothing downstream changes: the PDF stamp still scales whatever it is given
 * into its own box.
 */
interface SignaturePadModalProps {
  /** Saved signature as a PNG data URL, or empty/undefined when unsigned. */
  value?: string | null;
  /** Receives the PNG data URL, or `''` when the signature is cleared. */
  onChange: (value: string) => void;
  /** Render read-only: the signature is shown but cannot be changed. */
  disabled?: boolean;
  /** Accessible name, e.g. "Houseparent on Duty signature". */
  label: string;
  /** Shown in the trigger and the dialog while the pad is empty. */
  hint?: string;
  /** Extra classes for the trigger. */
  className?: string;
  /** Backing-store size of the modal canvas. */
  width?: number;
  height?: number;
}

export function SignaturePadModal({
  value,
  onChange,
  disabled = false,
  label,
  hint = 'Sign here',
  className = '',
  width = 1000,
  height = 300,
}: SignaturePadModalProps) {
  const [open, setOpen] = useState(false);
  /**
   * Strokes are held here until Save. Cancelling therefore discards the draft
   * instead of silently overwriting a signature that was already on the record.
   */
  const [draft, setDraft] = useState<string>(value || '');
  /** Why the last uploaded file was refused, if it was. */
  const [uploadError, setUploadError] = useState('');

  // A record loaded underneath an open dialog (or a save elsewhere on the page)
  // must not leave the draft pointing at a different signer.
  useEffect(() => {
    if (!open) setDraft(value || '');
  }, [value, open]);

  const hasSignature = Boolean(value);

  const openDialog = () => {
    if (disabled) return;
    setDraft(value || '');
    setUploadError('');
    setOpen(true);
  };

  /**
   * Takes an uploaded image as the draft. Normalised to the pad's own size and
   * re-encoded as PNG, so what the caller receives is byte-for-byte the same
   * shape as a drawn signature.
   */
  const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared first, so choosing the same file twice still raises a change event.
    event.target.value = '';
    if (!file) return;
    setUploadError('');
    try {
      setDraft(await imageFileToSignaturePng(file, width, height));
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'That image could not be used.');
    }
  };

  const save = () => {
    onChange(draft || '');
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        disabled={disabled}
        aria-label={label}
        title={disabled ? label : `${label} — click to sign`}
        className={[
          'group relative flex h-full w-full items-center justify-center overflow-hidden rounded-sm',
          'border border-dashed transition-colors',
          disabled
            ? 'cursor-not-allowed border-gray-300/70 bg-gray-50/60'
            : 'cursor-pointer border-gray-300/80 bg-transparent hover:border-[#2F3E46]/50 hover:bg-yellow-200/40 focus:outline-none focus:ring-2 focus:ring-yellow-500/70',
          className,
        ].join(' ')}
      >
        {hasSignature ? (
          <img src={value || ''} alt={label} className="h-full w-full object-contain" />
        ) : (
          <span className="pointer-events-none flex items-center gap-1 text-[9px] font-semibold text-gray-400 group-hover:text-[#2F3E46]">
            <PenLine className="h-3 w-3" />
            {hint}
          </span>
        )}

        {hasSignature && !disabled && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/70 text-[9px] font-bold text-[#2F3E46] opacity-0 transition-opacity group-hover:opacity-100">
            Change
          </span>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        {/*
          Sized off the viewport rather than a fixed pixel width so the signing
          surface is usable on a phone in portrait as well as on a desktop.
        */}
        <DialogContent className="max-h-[95vh] w-[95vw] max-w-3xl overflow-y-auto rounded-2xl bg-white">
          <DialogHeader>
            <DialogTitle className="text-[#2F3E46]">{label}</DialogTitle>
            <DialogDescription>
              Draw your signature in the box below, or upload a picture of it, then choose Save
              signature.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-xl border border-gray-200 bg-white p-2">
              <SignaturePad
                label={label}
                value={draft}
                onChange={setDraft}
                width={width}
                height={height}
                className="rounded-lg"
              />
            </div>

            <p className="text-[11px] text-gray-500">
              Use a mouse, trackpad, stylus or finger. Clear removes everything; Redo restores it.
              You can also upload a photo or scan of your signature instead of drawing it.
            </p>

            {uploadError && (
              <p className="rounded-lg border border-red-100 bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
                {uploadError}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-4">
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-semibold text-[#2F3E46] hover:text-[#263440]">
                <Upload className="h-3.5 w-3.5" /> Upload a signature image
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={upload}
                />
              </label>

              {hasSignature && (
                <button
                  type="button"
                  onClick={() => {
                    setDraft('');
                    onChange('');
                    setOpen(false);
                  }}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-600 hover:text-red-700"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Remove signature
                </button>
              )}
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} className="font-semibold">
              Cancel
            </Button>
            <Button
              type="button"
              onClick={save}
              className="bg-[#2F3E46] font-bold text-white hover:bg-[#263440]"
            >
              Save signature
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
