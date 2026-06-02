'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Lightweight near-real-time: re-fetches the server component tree on an
 * interval so new messages / quotes / statuses appear without a manual
 * refresh. Pauses while the tab is hidden. Tunnel- and standalone-safe
 * (plain HTTP, no websocket infra).
 */
export function AutoRefresh({ intervalMs = 7000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    timer = setInterval(tick, intervalMs);
    const onVis = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [router, intervalMs]);
  return null;
}
