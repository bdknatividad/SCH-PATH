import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/app/components/ui/alert-dialog';
import { Button } from '@/app/components/ui/button';
import { cn } from '@/app/components/ui/utils';
import { modalPointerGuard } from '@/app/components/ui/modalLayer';

/**
 * The system's own confirm / notify dialogs.
 *
 * Every workflow transition — submit, return for revision, approve, reject, save
 * draft — has to ask a question or report an outcome. The modules used to do
 * that with `window.alert` / `window.confirm` / `window.prompt`, which is wrong
 * in three visible ways:
 *
 *   · the browser frames the box with the page's own origin, so the dialog is
 *     titled "localhost:5173 says…" — an implementation detail shown to staff;
 *   · `prompt` is a single-line text box, so a reviewer's notes could not be
 *     formatted, could not be validated, and on some browsers is suppressed
 *     outright;
 *   · the outcome is not part of the app, so it cannot carry the module's
 *     wording, tone, or a list of what is still missing.
 *
 * This module replaces all three with one dialog the app owns, driven by a hook
 * so a caller can await the answer:
 *
 *   const dialog = useSystemDialog();
 *   if (!await dialog.confirm({ title: 'Approve this TRI?', ... })) return;
 *   await dialog.success('TRI approved.', 'The rating is now the official result.');
 *
 * Because it is one component, the tone, spacing and button order cannot drift
 * between modules, which is what "consistent across Reports, TRI, Anecdotal
 * Reports and Document Approval" means in practice.
 */

export type SystemDialogTone = 'success' | 'error' | 'warning' | 'info';

export interface SystemDialogRequest {
  title: string;
  description?: string;
  /** Bullet points — what is still missing, or what the action will affect. */
  items?: string[];
  /** Defaults to "Confirm" for a confirmation and "OK" for a notice. */
  confirmLabel?: string;
  /** Only used by `confirm`. Defaults to "Cancel". */
  cancelLabel?: string;
  tone?: SystemDialogTone;
}

export interface SystemDialogApi {
  /** Ask, and resolve `true` only when the caller confirms. */
  confirm: (request: SystemDialogRequest) => Promise<boolean>;
  /** Report, and resolve when the reader dismisses it. */
  notify: (request: SystemDialogRequest) => Promise<void>;
  success: (title: string, description?: string) => Promise<void>;
  /** A failed action. Named `failure` so it does not shadow `window.error`. */
  failure: (title: string, description?: string) => Promise<void>;
  /** A form that cannot proceed yet — an error tone, with the reasons listed. */
  validation: (title: string, options?: { description?: string; items?: string[] }) => Promise<void>;
}

const SystemDialogContext = createContext<SystemDialogApi | null>(null);

/**
 * The same API, callable without a hook.
 *
 * Some callers cannot use one: module-level helpers (the TRI PDF export, the
 * document downloader) are not components, and a large screen may report from a
 * dozen nested handlers where threading a hook through every one is noise. This
 * mirrors how `sonner` ships both `useToast()` and a bare `toast`, and it is the
 * same implementation either way — the provider registers it on mount.
 *
 * Before the provider mounts, `confirm` resolves `false` (the action does not
 * happen) and the notice helpers log to the console. A missing provider is a
 * wiring mistake, so it should be visible to a developer rather than silently
 * swallowed, but it must never be the reason a workflow transition runs.
 */
type SystemDialogHandler = (request: SystemDialogRequest, mode: 'confirm' | 'notice') => Promise<boolean>;

let systemDialogHandler: SystemDialogHandler | null = null;

function unavailable(kind: string): Promise<boolean> {
  console.error(`System dialog (${kind}) was called before the provider mounted.`);
  return Promise.resolve(false);
}

export const systemDialog: SystemDialogApi = {
  confirm: (request) => systemDialogHandler
    ? systemDialogHandler({ tone: 'warning', ...request }, 'confirm')
    : unavailable('confirm'),
  notify: (request) => (systemDialogHandler
    ? systemDialogHandler({ tone: 'info', ...request }, 'notice')
    : unavailable('notify')).then(() => undefined),
  success: (title, description) => (systemDialogHandler
    ? systemDialogHandler({ title, description, tone: 'success' }, 'notice')
    : unavailable('success')).then(() => undefined),
  failure: (title, description) => (systemDialogHandler
    ? systemDialogHandler({ title, description, tone: 'error' }, 'notice')
    : unavailable('failure')).then(() => undefined),
  validation: (title, options) => (systemDialogHandler
    ? systemDialogHandler({ title, description: options?.description, items: options?.items, tone: 'error' }, 'notice')
    : unavailable('validation')).then(() => undefined),
};

const TONES: Record<SystemDialogTone, {
  Icon: typeof CheckCircle2;
  iconClass: string;
  ring: string;
  actionClass: string;
}> = {
  success: {
    Icon: CheckCircle2,
    iconClass: 'text-green-600',
    ring: 'bg-green-50 border-green-200',
    actionClass: 'bg-green-600 hover:bg-green-700 text-white',
  },
  error: {
    Icon: AlertCircle,
    iconClass: 'text-red-600',
    ring: 'bg-red-50 border-red-200',
    actionClass: 'bg-red-600 hover:bg-red-700 text-white',
  },
  warning: {
    Icon: AlertTriangle,
    iconClass: 'text-amber-600',
    ring: 'bg-amber-50 border-amber-200',
    actionClass: 'bg-amber-600 hover:bg-amber-700 text-white',
  },
  info: {
    Icon: Info,
    iconClass: 'text-blue-600',
    ring: 'bg-blue-50 border-blue-200',
    actionClass: 'bg-[#2F3E46] hover:bg-[#263440] text-white',
  },
};

export function SystemDialogProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<{ request: SystemDialogRequest; mode: 'confirm' | 'notice' } | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  /**
   * True while a dialog is visible or still animating out.
   *
   * Kept separate from `resolver` because the two answer different questions.
   * `resolver` answers "is a caller still waiting for an answer?", which becomes
   * `null` the instant a button is pressed. This answers "is a Radix layer still
   * on screen?", which stays true until React has committed the unmount. The
   * decision below has to be made on the second question: a dialog that has been
   * answered but not yet unmounted is exactly the layer that would otherwise
   * collide with its replacement.
   */
  const layerMounted = useRef(false);

  /**
   * Cancels a replacement that is waiting on the next frame.
   *
   * Two `open()` calls in quick succession each queue a presentation. Without
   * this, both frames fire and the first one wins — mounting the *older* request
   * on top of the newer one. Each new replacement cancels the one before it, so
   * only the latest survives.
   */
  const cancelQueued = useRef<(() => void) | null>(null);

  /**
   * Opens a dialog, replacing whatever is showing.
   *
   * The yield before the new dialog is presented is deliberate and
   * load-bearing. The common shape in this app is
   *
   *   if (!await dialog.confirm(...)) return;
   *   await doTheThing();
   *   await dialog.success(...);
   *
   * so a confirm is settled and a notice opened moments later. Opening the
   * notice in the same synchronous turn as the confirm's dismissal makes two
   * Radix `DismissableLayer`s overlap: the outgoing layer is still in the
   * library's layer `Set` when the incoming one measures its position, so the
   * new dialog is judged "not the top layer" and Radix inlines
   * `pointer-events: none` on it. The dialog paints and Esc dismisses it (Escape
   * is a document-level key handler, not a pointer event), but nothing inside it
   * accepts a click — the reported bug, where only Esc gets you out.
   *
   * Waiting for the next frame lets React commit the dismissal, run the outgoing
   * layer's cleanup effect, and drop it from the `Set` first — so the incoming
   * dialog is unambiguously the top layer. `modalPointerGuard` in
   * `ui/modalLayer.ts` is the second line of defence, for dialogs that sit open
   * behind each other on purpose; this keeps the common case from reaching that
   * state at all.
   */
  const open = useCallback((request: SystemDialogRequest, mode: 'confirm' | 'notice') => (
    new Promise<boolean>((resolve) => {
      /** Presents the request and marks its layer as mounted. */
      const present = () => {
        cancelQueued.current = null;
        resolver.current = resolve;
        layerMounted.current = true;
        setPending({ request, mode });
      };

      // Nothing on screen: show it now, with no extra frame of latency.
      if (!layerMounted.current && !resolver.current) {
        present();
        return;
      }

      // Something is showing. A second request would strand the first promise,
      // so settle it as "no" — then wait a frame for its layer to leave the DOM
      // before presenting the replacement.
      resolver.current?.(false);
      resolver.current = null;
      layerMounted.current = false;
      cancelQueued.current?.();
      setPending(null);

      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(present);
      } else {
        setTimeout(present, 0);
      }

      // Lets a later `open()` supersede this queued presentation.
      cancelQueued.current = () => { resolve(false); };
    })
  ), []);


  /**
   * Settles the open dialog exactly once. Both buttons and a dismissal (Esc,
   * overlay) route through here, so the first one to arrive decides and the rest
   * are no-ops.
   */
  const settle = useCallback((value: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    layerMounted.current = false;
    setPending(null);
    resolve?.(value);
  }, []);

  // Publish the implementation for callers that have no hook to use. Cleared on
  // unmount so a torn-down app cannot answer a dialog.
  useEffect(() => {
    systemDialogHandler = open;
    return () => { systemDialogHandler = null; };
  }, [open]);

  const api = useMemo<SystemDialogApi>(() => ({
    confirm: (request) => open({ tone: 'warning', ...request }, 'confirm'),
    notify: (request) => open({ tone: 'info', ...request }, 'notice').then(() => undefined),
    success: (title, description) => open({ title, description, tone: 'success' }, 'notice').then(() => undefined),
    failure: (title, description) => open({ title, description, tone: 'error' }, 'notice').then(() => undefined),
    validation: (title, options) => open(
      { title, description: options?.description, items: options?.items, tone: 'error' },
      'notice',
    ).then(() => undefined),
  }), [open]);

  const tone = TONES[pending?.request.tone ?? 'info'];
  const isConfirm = pending?.mode === 'confirm';
  const { Icon } = tone;

  return (
    <SystemDialogContext.Provider value={api}>
      {children}
      <AlertDialog open={Boolean(pending)} onOpenChange={(next) => { if (!next) settle(false); }}>
        {/* `modalPointerGuard` keeps every button in here clickable when this
            dialog is opened from inside another one — the reject / reassessment
            form, the upload form. Without it Radix inlines
            `pointer-events: none` on the content whenever it is not judged the
            top layer, and the dialog paints but refuses clicks; Esc still works,
            because Escape is a document-level key handler, not a pointer event.
            See `ui/modalLayer.ts` for the full mechanism. */}
        <AlertDialogContent
          className="max-w-[calc(100%-2rem)] gap-0 overflow-hidden p-0 sm:max-w-md"
          style={modalPointerGuard}
        >
          {pending && (
            <>
              <AlertDialogHeader className="gap-0 space-y-0 text-left">
                <div className={cn('flex items-start gap-3 border-b px-5 py-4', tone.ring)}>
                  <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', tone.iconClass)} />
                  <AlertDialogTitle className="text-base font-bold leading-snug text-[#2F3E46]">
                    {pending.request.title}
                  </AlertDialogTitle>
                </div>
                {(pending.request.description || pending.request.items?.length) && (
                  <div className="space-y-3 px-5 py-4">
                    {pending.request.description && (
                      <AlertDialogDescription className="whitespace-pre-line text-sm leading-relaxed text-gray-600">
                        {pending.request.description}
                      </AlertDialogDescription>
                    )}
                    {Boolean(pending.request.items?.length) && (
                      <ul className="max-h-52 space-y-1.5 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-3">
                        {pending.request.items!.map((item, index) => (
                          <li key={index} className="flex gap-2 text-xs leading-relaxed text-gray-700">
                            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-gray-400" />
                            <span className="min-w-0 break-words">{item}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </AlertDialogHeader>
              <div className="flex flex-col-reverse gap-2 border-t border-gray-100 bg-gray-50 px-5 py-3 sm:flex-row sm:justify-end">
                {isConfirm && (
                  <Button variant="outline" className="text-sm" onClick={() => settle(false)}>
                    {pending.request.cancelLabel || 'Cancel'}
                  </Button>
                )}
                <Button className={cn('text-sm font-bold', tone.actionClass)} onClick={() => settle(true)}>
                  {pending.request.confirmLabel || (isConfirm ? 'Confirm' : 'OK')}
                </Button>
              </div>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </SystemDialogContext.Provider>
  );
}

/**
 * The dialog API. Throws rather than returning a no-op when the provider is
 * missing: a silently inert confirm would let a workflow transition run without
 * the question being asked.
 */
export function useSystemDialog(): SystemDialogApi {
  const context = useContext(SystemDialogContext);
  if (!context) throw new Error('useSystemDialog must be used within a SystemDialogProvider');
  return context;
}
