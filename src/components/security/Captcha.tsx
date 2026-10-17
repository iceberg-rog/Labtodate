'use client';

import 'altcha/altcha.css';
import type {} from 'altcha/types/react';
import type { AltchaWidgetElement } from 'altcha';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CAPTCHA_HEADER, isCaptchaError, type CaptchaPurpose } from '@/lib/security/captcha-shared';

/**
 * The "I'm not a robot" bot check: an ALTCHA proof-of-work widget. The
 * browser solves a small puzzle from /api/captcha (about a second, no images,
 * no cookies, nothing loaded from another site) and the solution is sent with
 * the request it protects; the server verifies it (src/lib/security/captcha.ts).
 * Each solution is accepted once, so after every request the widget starts a
 * fresh puzzle in the background for the next try.
 *
 * The widget runs with auto="off" and its inputs detached from the form: its
 * checkbox is `required` otherwise, and the browser then silently refuses to
 * submit the whole form while the puzzle is unsolved (still running, or
 * expired after a long pause). This hook starts the puzzle itself — when the
 * form gets focus ('focus') or as soon as it shows ('load') — and `token()`
 * waits for it at submit time.
 *
 * The widget's code is loaded only when a form needs it. Its worker is served
 * from this site (/altcha/pbkdf2.js, copied by scripts/copy-altcha-worker.mjs),
 * so the Content-Security-Policy needs no blob: workers.
 */

let loading: Promise<void> | null = null;
function loadWidget(): Promise<void> {
  if (!loading) {
    loading = import('altcha/external').then(() => {
      const make = () => new Worker('/altcha/pbkdf2.js');
      for (const alg of ['PBKDF2/SHA-256', 'PBKDF2/SHA-384', 'PBKDF2/SHA-512']) globalThis.$altcha.algorithms.set(alg, make);
    });
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Longest wait for a puzzle at submit time (the widget's own timeout is 90 s). */
const SOLVE_TIMEOUT_MS = 90_000;

type Status = 'idle' | 'verifying' | 'verified' | 'error';

export type Captcha = {
  /** The widget (null while the check isn't needed). */
  widget: React.ReactNode;
  /** Whether requests need a solved check. */
  required: boolean;
  /** Solve (or reuse the solved) check: '' when not required, null when it couldn't be solved. */
  token: () => Promise<string | null>;
  /** Headers for a better-auth call (`fetchOptions.headers`). */
  headers: (token: string | null) => Record<string, string>;
  /** A request used the token (accepted or not): start a fresh puzzle for the next one. */
  reset: () => void;
  /** Switch the check on now (e.g. before an e-mailed sign-in link). */
  require: () => void;
  /** The server answered CAPTCHA_* / captchaRequired: switch the check on. Returns whether it did. */
  handleError: (err: { code?: string; captchaRequired?: boolean } | null | undefined) => boolean;
};

export function useCaptcha(purpose: CaptchaPurpose, opts: { required: boolean; start?: 'load' | 'focus' }): Captcha {
  const start = opts.start ?? 'load';
  const [required, setRequired] = useState(opts.required);
  const [status, setStatus] = useState<Status>('idle');
  const [loaded, setLoaded] = useState(false);
  const requiredRef = useRef(opts.required);
  const ref = useRef<AltchaWidgetElement | null>(null);
  const payload = useRef<string | null>(null);
  const stateRef = useRef<string>('unverified');

  const requireIt = useCallback(() => {
    requiredRef.current = true;
    setRequired(true);
  }, []);

  useEffect(() => {
    if (opts.required) requireIt();
  }, [opts.required, requireIt]);

  useEffect(() => {
    if (!required) return;
    let alive = true;
    loadWidget()
      .then(() => alive && setLoaded(true))
      .catch(() => alive && setStatus('error'));
    return () => {
      alive = false;
    };
  }, [required]);

  /** Start solving unless it already runs or is solved. */
  const kick = useCallback(() => {
    const el = ref.current;
    if (!el?.verify || payload.current || stateRef.current === 'verifying') return;
    void el.verify().catch(() => null);
  }, []);

  // Follow the widget's state, and start the puzzle (on load, or on the
  // first focus inside the form — at once when focus is already there).
  useEffect(() => {
    const el = ref.current;
    if (!loaded || !el) return;
    const onState = (ev: Event) => {
      const detail = (ev as CustomEvent<{ state: string; payload?: string }>).detail;
      stateRef.current = detail.state;
      if (detail.state === 'verified' && detail.payload) {
        payload.current = detail.payload;
        setStatus('verified');
      } else if (detail.state === 'verifying') {
        setStatus('verifying');
      } else if (detail.state === 'error') {
        payload.current = null;
        setStatus('error');
      } else {
        // unverified / expired: the next token() solves a new puzzle.
        payload.current = null;
        setStatus('idle');
      }
    };
    el.addEventListener('statechange', onState);
    // The widget's own inputs (its checkbox is `required` while solving) must
    // not take part in the form's validation, or the browser silently refuses
    // to submit until the puzzle is done; token() waits for it instead.
    const detachInputs = () =>
      el.querySelectorAll('input').forEach((i) => {
        if (i.getAttribute('form') !== 'altcha-no-form') i.setAttribute('form', 'altcha-no-form');
      });
    const observer = new MutationObserver(detachInputs);
    observer.observe(el, { childList: true, subtree: true });
    detachInputs();
    const form = el.closest('form');
    let detach = () => {};
    const ready = (window.customElements?.whenDefined?.('altcha-widget') ?? Promise.resolve()).then(() => sleep(0));
    void ready.then(() => {
      if (start === 'load' || !form || form.contains(document.activeElement)) {
        kick();
        return;
      }
      const onFocus = () => {
        kick();
        form.removeEventListener('focusin', onFocus);
      };
      form.addEventListener('focusin', onFocus);
      detach = () => form.removeEventListener('focusin', onFocus);
    });
    return () => {
      el.removeEventListener('statechange', onState);
      observer.disconnect();
      detach();
    };
  }, [loaded, start, kick]);

  const token = useCallback(async (): Promise<string | null> => {
    if (!requiredRef.current) return '';
    if (payload.current) return payload.current;
    await loadWidget().catch(() => undefined);
    // Just switched on: the element renders on the next frames.
    for (let i = 0; i < 100 && !ref.current?.verify; i++) await sleep(30);
    const el = ref.current;
    if (!el?.verify) return null;
    if (!payload.current && stateRef.current !== 'verifying') {
      const result = await el.verify().catch(() => null);
      if (result?.payload) payload.current = result.payload;
    }
    // A puzzle started earlier (on focus / on load) is still running: wait for it.
    const end = Date.now() + SOLVE_TIMEOUT_MS;
    while (!payload.current && stateRef.current === 'verifying' && Date.now() < end) await sleep(100);
    return payload.current;
  }, []);

  const reset = useCallback(() => {
    payload.current = null;
    const el = ref.current;
    if (!el?.reset) return;
    try {
      el.reset();
      stateRef.current = 'unverified';
      // Have the next puzzle ready by the time the person tries again.
      setTimeout(() => void el.verify?.().catch(() => null), 50);
    } catch {
      /* not upgraded yet */
    }
  }, []);

  const handleError = useCallback(
    (err: { code?: string; captchaRequired?: boolean } | null | undefined) => {
      if (!err || !(err.captchaRequired || isCaptchaError(err.code))) return false;
      if (requiredRef.current) reset();
      else requireIt();
      return true;
    },
    [requireIt, reset],
  );

  const widget = required ? (
    <div className="captcha-box" data-testid={`captcha-${purpose}`} data-status={status}>
      {loaded ? (
        <altcha-widget
          ref={ref as React.Ref<HTMLElement>}
          challenge={`/api/captcha?purpose=${purpose}`}
          auto="off"
          name="altcha"
          type="checkbox"
          configuration={JSON.stringify({ hideLogo: true })}
        />
      ) : (
        <div className="h-[58px] rounded-xl border border-input bg-background/60 animate-pulse" aria-hidden />
      )}
      {status === 'error' && (
        <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">
          The check couldn’t finish. Tick the box to try again; if it keeps failing, reload the page.
        </p>
      )}
    </div>
  ) : null;

  return {
    widget,
    required,
    token,
    headers: (t): Record<string, string> => (t ? { [CAPTCHA_HEADER]: t } : {}),
    reset,
    require: requireIt,
    handleError,
  };
}

/** Text for a check that could not be solved in the browser. */
export const CAPTCHA_NOT_SOLVED = 'Please complete the “I’m not a robot” check first (tick the box), then try again.';
