import { LifeBuoy, Clock, ShieldCheck, CalendarClock } from 'lucide-react';
import { getServerSession } from '@/lib/auth-server';
import { SupportForm } from '@/components/support/SupportForm';
import { supportFormProps, type SupportFormQuery } from '@/lib/support/form-props';
import { businessTimeZone, supportHoursText } from '@/lib/support/policy';

export const metadata = { title: 'Support' };
export const dynamic = 'force-dynamic';

export default async function SupportPage(props: { searchParams?: Promise<SupportFormQuery> }) {
  const session = await getServerSession();
  const form = await supportFormProps(session, (await props.searchParams) ?? {});
  const hours = supportHoursText();
  return (
    <div className="container-px py-12 md:py-20">
      <div className="grid lg:grid-cols-[1fr_1.3fr] gap-12 items-start max-w-6xl mx-auto">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-accent/15 border border-accent/30 px-3 py-1 text-xs font-bold text-primary mb-5">
            <LifeBuoy className="h-3.5 w-3.5" /> Support
          </div>
          <h1 className="text-4xl md:text-5xl font-bold leading-[1.05]" style={{ letterSpacing: '-0.04em' }}>
            How can we help?
          </h1>
          <p className="mt-5 text-lg text-muted-foreground leading-relaxed">
            Open a ticket — orders, quotes, billing, selling or technical questions. You get a
            reference number and a reply by email.
          </p>
          <ul className="mt-8 space-y-4">
            {form.replyPromise && (
              <li className="flex gap-3"><Clock className="h-5 w-5 text-primary flex-shrink-0" /><span className="text-sm">Replies within <strong>{form.replyPromise}</strong></span></li>
            )}
            {hours && (
              <li className="flex gap-3"><CalendarClock className="h-5 w-5 text-primary flex-shrink-0" /><span className="text-sm">Support hours: <strong>{hours}</strong> <span className="text-muted-foreground">({businessTimeZone().replace(/_/g, ' ')} time)</span></span></li>
            )}
            <li className="flex gap-3"><ShieldCheck className="h-5 w-5 text-primary flex-shrink-0" /><span className="text-sm">Every ticket is tracked end to end</span></li>
          </ul>
        </div>
        <SupportForm {...form} />
      </div>
    </div>
  );
}
