'use client';

import { useState, type ReactNode } from 'react';
import {
  Mail,
  CreditCard,
  Building2,
  Megaphone,
  Sparkles,
  Wrench,
  Tags,
  Bot,
  Image as ImageIcon,
  Webhook,
} from 'lucide-react';

const ICONS: Record<string, ReactNode> = {
  Email: <Mail className="h-4 w-4" />,
  Payments: <CreditCard className="h-4 w-4" />,
  Brand: <Sparkles className="h-4 w-4" />,
  Company: <Building2 className="h-4 w-4" />,
  Marketing: <Megaphone className="h-4 w-4" />,
  Commerce: <Tags className="h-4 w-4" />,
  Selling: <Wrench className="h-4 w-4" />,
  'AI assistant': <Bot className="h-4 w-4" />,
  Logo: <ImageIcon className="h-4 w-4" />,
  Webhooks: <Webhook className="h-4 w-4" />,
};

export function SettingsTabs({
  groups,
  panels,
  initial,
}: {
  groups: string[];
  panels: Record<string, ReactNode>;
  initial?: string;
}) {
  const [active, setActive] = useState<string>(initial && groups.includes(initial) ? initial : groups[0]);

  return (
    <div className="grid md:grid-cols-[220px_1fr] gap-6 items-start">
      <nav className="md:sticky md:top-20 flex md:flex-col gap-1 overflow-x-auto md:overflow-visible rounded-2xl border border-border bg-card p-2">
        {groups.map((g) => {
          const on = active === g;
          return (
            <button
              key={g}
              type="button"
              onClick={() => setActive(g)}
              className={`inline-flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-semibold whitespace-nowrap transition-colors ${
                on
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
              }`}
            >
              <span className={on ? 'text-primary-foreground' : 'text-muted-foreground'}>
                {ICONS[g] ?? <Wrench className="h-4 w-4" />}
              </span>
              {g}
            </button>
          );
        })}
      </nav>

      <div className="min-w-0 space-y-6">
        {groups.map((g) => (
          <div key={g} className={active === g ? 'block' : 'hidden'}>
            {panels[g]}
          </div>
        ))}
      </div>
    </div>
  );
}
