'use client';

import { useEffect } from 'react';
import type { LandingConfig } from './engine/shell';

/**
 * Starts the homepage engine (ported from the Shelter landing) after the first
 * paint: the scroll model, rail, tour, demo and tabs at once, the WebGL scene
 * (three.js, its own chunk) once the intro's poster is up. Everything it
 * attaches is torn down on unmount, so navigating away and back is clean.
 */
export function LandingShell({ config }: { config: LandingConfig }) {
  const key = JSON.stringify(config);
  useEffect(() => {
    let handle: { dispose(): void } | null = null;
    let dead = false;
    import('./engine/shell.js')
      .then((m) => {
        if (!dead) handle = m.startLanding(JSON.parse(key) as LandingConfig);
      })
      .catch((e) => console.warn('landing engine unavailable', e));
    return () => {
      dead = true;
      handle?.dispose();
    };
  }, [key]);
  return null;
}
