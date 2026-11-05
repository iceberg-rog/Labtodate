import { legalContext } from '@/components/site/LegalShell';
import { getServerSession } from '@/lib/auth-server';
import { siteInline, siteTexts, siteValue } from '@/lib/site/content';
import { SupportForm } from '@/components/support/SupportForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Contact' };

export default async function ContactPage() {
  const c = await legalContext();
  const session = await getServerSession();
  // Texts: Admin → Site content → Page: Contact. The company values below come from Settings → Company.
  const [tx, sellText, findText, supportReplyTime] = await Promise.all([
    siteTexts([
      'page_contact.title', 'page_contact.intro', 'page_contact.general_label', 'page_contact.sell_label',
      'page_contact.find_label', 'page_contact.office_label', 'page_contact.form_intro',
    ] as const),
    siteInline('page_contact.sell_text'),
    siteInline('page_contact.find_text'),
    siteValue('rules.support_reply_time'),
  ]);
  return (
    <div className="container-px py-12 md:py-20">
      <div className="grid lg:grid-cols-[1fr_1.3fr] gap-12 items-start max-w-6xl mx-auto">
        <div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight" style={{ letterSpacing: '-0.04em' }}>
            {tx['page_contact.title']}
          </h1>
          {tx['page_contact.intro'] && <p className="mt-4 text-lg text-muted-foreground">{tx['page_contact.intro']}</p>}

          <div className="mt-8 space-y-5 text-sm">
            {(c.email || c.phone) && (
              <div>
                <p className="font-bold">{tx['page_contact.general_label']}</p>
                <p className="text-muted-foreground">
                  {c.email ? <a href={`mailto:${c.email}`} className="hover:text-foreground">{c.email}</a> : null}
                  {c.email && c.phone ? ' · ' : null}
                  {c.phone || null}
                </p>
              </div>
            )}
            {/* siteInline() output is escaped by construction (admin text, no HTML). */}
            {tx['page_contact.sell_label'] && (
              <div>
                <p className="font-bold">{tx['page_contact.sell_label']}</p>
                <p className="text-muted-foreground [&_a]:text-primary" dangerouslySetInnerHTML={{ __html: sellText }} />
              </div>
            )}
            {tx['page_contact.find_label'] && (
              <div>
                <p className="font-bold">{tx['page_contact.find_label']}</p>
                <p className="text-muted-foreground [&_a]:text-primary" dangerouslySetInnerHTML={{ __html: findText }} />
              </div>
            )}
            <div>
              <p className="font-bold">{tx['page_contact.office_label']}</p>
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
          {tx['page_contact.form_intro'] && <p className="text-sm font-semibold mb-3">{tx['page_contact.form_intro']}</p>}
          <SupportForm defaultEmail={session?.user.email ?? ''} replyTime={supportReplyTime} />
        </div>
      </div>
    </div>
  );
}
