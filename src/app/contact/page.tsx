import { legalContext } from '@/components/site/LegalShell';
import { getServerSession } from '@/lib/auth-server';
import { SupportForm } from '@/components/support/SupportForm';
import { supportFormProps, type SupportFormQuery } from '@/lib/support/form-props';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Contact' };

export default async function ContactPage(props: { searchParams?: Promise<SupportFormQuery> }) {
  const c = await legalContext();
  const session = await getServerSession();
  // Same form as /support: signed in, the ticket uses the account's name and e-mail.
  const form = await supportFormProps(session, (await props.searchParams) ?? {});
  return (
    <div className="container-px py-12 md:py-20">
      <div className="grid lg:grid-cols-[1fr_1.3fr] gap-12 items-start max-w-6xl mx-auto">
        <div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight" style={{ letterSpacing: '-0.04em' }}>
            Contact us
          </h1>
          <p className="mt-4 text-lg text-muted-foreground">We reply by email.</p>

          <div className="mt-8 space-y-5 text-sm">
            <div>
              <p className="font-bold">General &amp; support</p>
              <p className="text-muted-foreground">
                <a href={c.contactHref} className="hover:text-foreground">{c.contactLabel}</a>
                {c.phone ? <> · {c.phone}</> : null}
              </p>
            </div>
            <div>
              <p className="font-bold">Sell equipment</p>
              <p className="text-muted-foreground">Free valuation via <a href="/sell" className="text-primary">Sell equipment</a>.</p>
            </div>
            <div>
              <p className="font-bold">Need a specific item?</p>
              <p className="text-muted-foreground"><a href="/let-us-find-it" className="text-primary">Let us find it</a>.</p>
            </div>
            <div>
              <p className="font-bold">Registered office</p>
              <p className="text-muted-foreground">
                {c.legal}
                {c.address ? <>, {c.address}</> : null}
                {c.country ? <>, {c.country}</> : null}
                {c.vat ? <><br />VAT / Reg: {c.vat}</> : null}
              </p>
            </div>
          </div>
        </div>

        <div>
          <p className="text-sm font-semibold mb-3">Send us a message — we&apos;ll open a tracked ticket.</p>
          <SupportForm {...form} />
        </div>
      </div>
    </div>
  );
}
