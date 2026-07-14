import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-background/90 text-foreground shadow-sm',
        accent: 'border-transparent bg-accent/15 text-accent',
        outline: 'text-foreground',
        success: 'border-transparent bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300',
        warning: 'border-transparent bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
