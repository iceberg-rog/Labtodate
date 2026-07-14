'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Light / dark toggle. Flips the `.dark` class on <html> and persists the
 * choice to localStorage('theme'); the initial class is set pre-paint by
 * ThemeScript so there is no flash. Icon is gated on `mounted` to avoid a
 * hydration mismatch (server can't know the resolved theme).
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [mounted, setMounted] = useState(false);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setMounted(true);
    setIsDark(document.documentElement.classList.contains('dark'));
  }, []);

  function toggle() {
    const el = document.documentElement;
    const next = !el.classList.contains('dark');
    el.classList.toggle('dark', next);
    el.style.colorScheme = next ? 'dark' : 'light';
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light');
    } catch {
      /* storage unavailable — toggle still applies for this session */
    }
    setIsDark(next);
  }

  const dark = mounted && isDark;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={dark ? 'Light mode' : 'Dark mode'}
      className={cn(
        'inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground',
        className,
      )}
    >
      <Sun className={cn('h-5 w-5', dark ? 'block' : 'hidden')} />
      <Moon className={cn('h-5 w-5', dark ? 'hidden' : 'block')} />
    </button>
  );
}
