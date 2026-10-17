'use client';

import { useEffect } from 'react';
import { startLanding, type LandingConfig } from './engine/shell';

/**
 * Starts the homepage engine (ported from the Shelter landing) after the first
 * paint: the scroll model, rail, tour, demo and tabs at once, the WebGL scene
 * (three.js, its own chunk) once the intro's poster is up. Everything it
 * attaches is torn down on unmount, so navigating away and back is clean.
 */
export function LandingShell({ config }: { config: LandingConfig }) {
  const key = JSON.stringify(config);
  useEffect(() => {
    // (the shell ships with the page: ~15 KB, no extra round trip before the poster; three.js stays a chunk of its
    // own, loaded once the poster is up)
    let handle: { dispose(): void } | null = null;
    try {
      handle = startLanding(JSON.parse(key) as LandingConfig);
    } catch (e) {
      console.warn('landing engine unavailable', e);
    }
    return () => handle?.dispose();
  }, [key]);
  return null;
}
