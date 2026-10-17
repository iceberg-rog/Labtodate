import Link from 'next/link';
import { ArrowRight, ArrowUpRight, Check, FileText, LayoutGrid, Plus, Search, ShoppingCart, Tag } from 'lucide-react';
import { SearchTypeahead } from '@/components/site/SearchTypeahead';
import {
  type HomeContent,
  type HomeStation,
  parseCta,
  parseGeoLines,
  parseTitleLines,
  parseWays,
  searchPlaceholderFor,
  HOME_DEFAULTS,
} from '@/lib/home-sections';
import type { DemoProduct, StationCategory } from '@/lib/home-landing-data';
import { LandingShell } from './LandingShell';
import type { LandingConfig } from './engine/shell';
import './landing.css';
import { loadDirectly } from '@/lib/image-hosts';

// A photo through the image optimizer — or, on a host the optimizer may not fetch (src/lib/image-hosts.ts), loaded by
// the browser as it is.
function img(src: string | null | undefined, w: number): string | null {
  if (!src) return null;
  return loadDirectly(src) ? src : `/_next/image?url=${encodeURIComponent(src)}&w=${w}&q=75`;
}

/** Scroll length of each pinned station (the Shelter landing's --h). */
const HEIGHT: Record<HomeStation, string> = { intro: '180vh', hero: '120vh', categories: '430vh', suppliers: '150vh', process: '125vh', ways: '120vh', cta: '150vh' };
const NAME: Record<HomeStation, string> = { intro: 'INTRO', hero: 'MARKET', categories: 'INSTRUMENTS', suppliers: 'ROUTE', process: 'BUYING', ways: 'WAYS TO BUY', cta: 'SOURCE' };
const pad = (n: number) => String(n).padStart(2, '0');

function splitAccent(text: string): [string, string] {
  const m = text.trim().match(/^(.*[.!?])\s+([^.!?]+[.!?]?)$/);
  return m ? [m[1], m[2]] : ['', text];
}

export interface LandingProps {
  stations: HomeStation[];
  content: HomeContent;
  siteName: string;
  categories: StationCategory[];
  listings: number;
  demo: DemoProduct | null;
  sourcingNote: string;
  children?: React.ReactNode; // optional extra modules, after the stations
}

/**
 * The homepage, built on the Shelter landing's structure: pinned scroll
 * stations (each .sec is --h tall; its .stick panel stays on screen while the
 * scroll drives that station's 3D), one fixed WebGL canvas, a section rail,
 * HUD frame + meta line, the auto tour and the reveal (.rv) system. All copy
 * is server-rendered from Admin → Homepage; LandingShell adds the behaviour
 * and loads the 3D scene after the first paint.
 */
export function Landing({ stations, content: c, siteName, categories, listings, demo, sourcingNote, children }: LandingProps) {
  const word = c.introWord || siteName;
  const tagline = c.introTagline.replaceAll('{SITE}', siteName);
  const tagAt = tagline.indexOf(siteName);
  const [demoLabel, demoHref] = parseCta(c.demoCta, ['Create your account', '/auth/sign-up']);
  const ways = parseWays(c.waysItems);
  const steps = parseTitleLines(c.netSteps, 4);
  const bullets = parseTitleLines(c.demoBullets, 5);
  const chips = c.waysChips.split(',').map((s) => s.trim()).filter(Boolean);
  const [ctaLead, ctaAccent] = splitAccent(c.ctaHeading);
  const hub = parseGeoLines(c.netHub)[0] ?? parseGeoLines(HOME_DEFAULTS.netHub)[0];
  const lanes = parseGeoLines(c.netLanes);
  // the instruments' cards (scene.js: the card helix round the formula column): the category's photo seen through frosted
  // glass, its leading brands above the title and its live count under it
  const CARD_C: [string, string][] = [['#a4e335', '#0b2a1c'], ['#2fd6c3', '#062a28'], ['#7fd11f', '#0f2a14'], ['#14b8a6', '#05242a'], ['#d4f56a', '#1a2a0c']];
  const config: LandingConfig = {
    links: {},
    games: categories.map((k, i) => ({
      name: k.name, slug: k.slug, c: CARD_C[i % CARD_C.length], plat: k.brands.slice(0, 3),
      fa: `${k.count.toLocaleString('en-US')} ${k.count === 1 ? 'listing' : 'listings'}`, wide: img(k.image, 1080), artSm: img(k.image, 640),
    })),
    text: { outro: c.outroWord, globe_labs: c.netLabs, geo_node: hub?.label ?? '' },
    hub: hub ?? null,
    lanes,
  };
  const first = categories[0];

  const section = (id: HomeStation, body: React.ReactNode, extra: React.HTMLAttributes<HTMLElement> & Record<string, unknown> = {}) => (
    <section key={id} id={id} className="sec" data-station={id} data-name={NAME[id]} style={{ ['--h' as string]: HEIGHT[id] }} {...extra}>
      <div className="stick">{body}</div>
    </section>
  );

  const render: Record<HomeStation, React.ReactNode> = {
    intro: section('intro', (
      <>
        <div className="intro-word" aria-hidden data-word={word}>
          <span className="text-grad">{word}</span>
        </div>
        <p className="intro-tag rv">
          {tagAt >= 0 ? (<>{tagline.slice(0, tagAt)}<strong>{siteName}</strong>{tagline.slice(tagAt + siteName.length)}</>) : tagline}
        </p>
        <a href="#hero" className="scroll-hint rv" style={{ ['--d' as string]: 2 }}><span className="mouse"><i /></span>SCROLL TO ENTER</a>
        <button id="lnd-tour-btn" className="tour-btn rv" style={{ ['--d' as string]: 3 }} type="button">
          <span className="tb-ring" aria-hidden><svg viewBox="0 0 12 12"><path d="M4 2.6v6.8L9.6 6z" /></svg></span>
          Auto tour
        </button>
      </>
    ), { 'aria-label': `${siteName} intro` }),

    hero: section('hero', (
      <>
        <div className="hero-copy">
          <span className="kicker rv">{c.heroBadge}</span>
          <h1 id="h-hero" className="rv" style={{ ['--d' as string]: 1 }}>
            {c.heroTitle} <span className="text-grad">{c.heroAccent}</span>
          </h1>
          <p className="lead rv" style={{ ['--d' as string]: 2 }}>{c.heroSubtitle}</p>
          <div className="hero-search glass-panel rv" style={{ ['--d' as string]: 3 }}>
            <SearchTypeahead size="lg" className="min-w-0 flex-1" placeholder={searchPlaceholderFor(c.popular)} />
            <Link prefetch={false} href="/marketplace" className="btn btn-p">Browse <ArrowRight className="h-4 w-4" /></Link>
          </div>
          <div className="cta-row rv" style={{ ['--d' as string]: 4 }}>
            <Link prefetch={false} href="/let-us-find-it" className="btn btn-g">Can&apos;t find it? Let us source it <ArrowRight className="h-4 w-4" /></Link>
            <Link prefetch={false} href="/sell" className="btn-link">Sell your equipment →</Link>
          </div>
          {c.popular.length > 0 && (
            <div className="chips rv" style={{ ['--d' as string]: 5 }}>
              {c.popular.map((t) => <Link prefetch={false} key={t} href={`/marketplace?q=${encodeURIComponent(t)}`} className="chip">{t}</Link>)}
            </div>
          )}
        </div>
        <div className="hero-side rv" style={{ ['--d' as string]: 4 }} aria-hidden={c.stats.length === 0}>
          {c.stats.map((s) => (
            <div key={s.label}><b>{s.value.toLocaleString('en-US')}{s.suffix}</b> {s.label}</div>
          ))}
          <div>{c.popular.slice(0, 4).join(' · ')}</div>
        </div>
        <div className="hero-fallback" aria-hidden>
          <svg viewBox="0 0 64 46">
            <line x1="4" y1="40" x2="34" y2="40" stroke="url(#l2d-mark-grad)" strokeWidth="1.6" strokeLinecap="round" />
            <g fill="url(#l2d-mark-grad)"><circle cx="8" cy="31" r="2.4" /><circle cx="17" cy="22" r="3.6" /><circle cx="27" cy="11" r="6.2" /><circle cx="38" cy="16" r="4.4" /><circle cx="47" cy="24" r="3.2" /><circle cx="55" cy="31" r="2.2" /></g>
          </svg>
        </div>
      </>
    ), { 'aria-labelledby': 'h-hero' }),

    categories: section('categories', (
      <>
        <div className="wk-pager rv" style={{ ['--d' as string]: 1 }}>
          <button id="wk-prev" type="button" aria-label="Previous category">&lt;&lt;</button>
          <span><b id="gp-i">01</b> / <span>{pad(categories.length)}</span><i id="gp-name">{first?.name ?? ''}</i></span>
          <button id="wk-next" type="button" aria-label="Next category">&gt;&gt;</button>
        </div>
        <div className="wk-ui">
          <h2 id="h-games" className="wk-q rv" style={{ ['--d' as string]: 1 }}>
            {c.catTitle} <span className="text-grad">{c.catAccent}</span>
          </h2>
          <ol className="wk-list rv" style={{ ['--d' as string]: 2 }} id="game-list">
            {categories.map((k, i) => (
              <li key={k.slug}>
                <button type="button" data-i={i} className={i === 0 ? 'on' : ''}>
                  <span className="ar">&lt;-</span>
                  <span className="nm">{k.name}</span>
                  <em>{pad(k.count).padStart(3, '0')}</em>
                </button>
              </li>
            ))}
          </ol>
          <Link prefetch={false} id="wk-open" href={first ? `/marketplace?category=${first.slug}` : '/marketplace'} className="wk-open rv" style={{ ['--d' as string]: 2 }}>
            Browse <b id="wk-open-name">{first?.name ?? 'the marketplace'}</b> <ArrowRight className="h-3.5 w-3.5" />
          </Link>
          <div className="wk-links rv" style={{ ['--d' as string]: 3 }}>
            <Link prefetch={false} className="wk-tile" href="/marketplace">
              <LayoutGrid aria-hidden />
              <span><b>{c.catAllTitle}</b><small>{c.catAllSub.replaceAll('{N}', listings.toLocaleString('en-US'))}</small></span>
              <ArrowUpRight className="go" aria-hidden />
            </Link>
            <Link prefetch={false} className="wk-tile alt" href="/let-us-find-it">
              <Plus aria-hidden />
              <span><b>{c.catAskTitle}</b><small>{c.catAskSub}</small></span>
              <ArrowUpRight className="go" aria-hidden />
            </Link>
          </div>
        </div>
        {/* crawlable category links (the list above is a jump list) */}
        <ul className="sr-only">
          {categories.map((k) => <li key={k.slug}><Link prefetch={false} href={`/marketplace?category=${k.slug}`}>{k.name} ({k.count})</Link></li>)}
        </ul>
        <div className="wk-fallback" aria-hidden>
          {categories.slice(0, 3).map((k) => (
            <div key={k.slug} className="wk-fcard">
              {k.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={img(k.image, 640) ?? undefined} alt="" loading="lazy" />
              )}
              <b>{k.name}</b>
            </div>
          ))}
        </div>
      </>
    ), { 'aria-labelledby': 'h-games' }),

    suppliers: section('suppliers', (
      <>
        <div className="geo" id="geo" aria-hidden />
        <div className="route-copy">
          <h2 id="h-route" className="rv" style={{ ['--d' as string]: 1 }}>
            {c.netTitle} <span className="text-grad">{c.netAccent}</span>
          </h2>
          <p className="lead rv" style={{ ['--d' as string]: 2 }}>{c.netSubtitle}</p>
          <ol className="steps rv" style={{ ['--d' as string]: 3 }}>
            {steps.map((s, i) => (
              <li key={i} className={i === 0 ? 'on' : ''}>
                <span className="n">{pad(i + 1)}</span>
                <div><h3>{s.title}</h3>{s.text && <p>{s.text}</p>}</div>
              </li>
            ))}
          </ol>
        </div>
        <div className="route-fallback" aria-hidden />
      </>
    ), { 'aria-labelledby': 'h-route' }),

    process: section('process', (
      <>
        <div className="app-copy">
          <h2 id="h-app" className="rv" style={{ ['--d' as string]: 1 }}>
            {c.demoTitle} <span className="text-grad">{c.demoAccent}</span>
          </h2>
          <p className="lead rv" style={{ ['--d' as string]: 2 }}>{c.demoLead}</p>
          <ul className="app-feats">
            {bullets.map((b, i) => (
              <li key={i} className="rv" style={{ ['--d' as string]: 3 + i }}><Check aria-hidden /><span><b>{b.title}</b>{b.text && <> — {b.text}</>}</span></li>
            ))}
          </ul>
          <div className="cta-row rv" style={{ ['--d' as string]: 3 + bullets.length }}>
            <Link prefetch={false} href={demoHref} className="btn btn-p">{demoLabel} <ArrowRight className="h-4 w-4" /></Link>
          </div>
        </div>
        <BuyDemo product={demo} note={c.demoNote} />
      </>
    ), { 'aria-labelledby': 'h-app' }),

    ways: section('ways', (
      <>
        <div className="ways-sky" aria-hidden><i className="w-beam b0" /><i className="w-beam b1" /><i className="w-floor" /></div>
        <div className="ways-head">
          <h2 id="h-ways" className="rv" style={{ ['--d' as string]: 1 }}>
            {c.waysTitle} <span className="text-grad">{c.waysAccent}</span>
          </h2>
          <p className="lead rv" style={{ ['--d' as string]: 2 }}>{c.waysLead}</p>
        </div>
        <div className="ways-tabs rv" style={{ ['--d' as string]: 2 }} role="tablist" aria-label="Ways to buy">
          {ways.map((w, i) => (
            <button key={w.title} type="button" role="tab" id={`way-tab-${i}`} aria-controls={`way-${i}`} aria-selected={i === 1} data-way={i} className={i === 1 ? 'on' : ''}>
              {w.title}{w.tag && <em>{w.tag}</em>}
            </button>
          ))}
        </div>
        <div className="ways-deal glass-panel rv" style={{ ['--d' as string]: 3 }}>
          <span className="hud-label ways-code" id="ways-code">{`WAY ${pad(2)} // ${ways[1]?.tag.toUpperCase() ?? ''}`}</span>
          <WayEmblem count={ways.length} active={1} />
          {ways.map((w, i) => (
            <div key={w.title} className={`ways-panel ${i === 1 ? 'on' : ''}`} id={`way-${i}`} role="tabpanel" aria-labelledby={`way-tab-${i}`} hidden={i !== 1}>
              <h3>{w.title}</h3>
              <p>{w.text}</p>
              <ul>{w.bullets.map((b) => <li key={b}><Check aria-hidden />{b}</li>)}</ul>
              <Link prefetch={false} href={w.href} className="btn btn-p">{w.cta} <ArrowRight className="h-4 w-4" /></Link>
            </div>
          ))}
        </div>
        {chips.length > 0 && (
          <ul className="ways-chips rv" style={{ ['--d' as string]: 4 }}>
            {chips.map((t) => <li key={t}><Check aria-hidden />{t}</li>)}
          </ul>
        )}
      </>
    ), { 'aria-labelledby': 'h-ways' }),

    cta: section('cta', (
      <>
        <div className="play-word" aria-hidden data-word={c.outroWord}><span className="text-grad">{c.outroWord}</span></div>
        <div className="play-copy">
          <h2 id="h-play" className="rv" style={{ ['--d' as string]: 1 }}>
            {ctaLead}{ctaLead && <br />}<span className="text-grad">{ctaAccent}</span>
          </h2>
          <p className="lead rv" style={{ ['--d' as string]: 2 }}>{c.ctaSubtitle}</p>
          <div className="cta-row rv" style={{ ['--d' as string]: 3 }}>
            <Link prefetch={false} href="/let-us-find-it" className="btn btn-p">Submit a sourcing request <ArrowRight className="h-4 w-4" /></Link>
            <Link prefetch={false} href="/contact" className="btn btn-g">Talk to sales</Link>
          </div>
          {sourcingNote && <p className="play-note rv" style={{ ['--d' as string]: 4 }}>{sourcingNote}</p>}
        </div>
      </>
    ), { 'aria-labelledby': 'h-play' }),
  };

  return (
    <div id="lnd" className="lnd">
      <canvas id="gl" aria-hidden />
      <div className="poster" id="poster" data-word={word} aria-hidden><canvas /></div>
      <div className="lnd-nogl" aria-hidden />
      <div className="lnd-hud" aria-hidden><i className="c c1" /><i className="c c2" /><i className="c c3" /><i className="c c4" /></div>
      <nav className="lnd-rail" aria-label="Sections">
        {stations.map((s, i) => (
          <button key={s} type="button" data-go={s}><i /><span>{pad(i + 1)} {NAME[s]}</span></button>
        ))}
      </nav>
      <div className="lnd-meta" aria-hidden><span>{`${siteName.toUpperCase()}//MOLECULAR ANALYSIS`}</span><span id="lnd-sec">{`SEC 01 // ${NAME[stations[0]]}`}</span></div>
      <div className="tour-bar" id="lnd-tour-bar" role="status" aria-hidden="true">
        <span className="tb-dot" aria-hidden />
        <span className="tb-t">Auto tour<small>Scroll or tap to take over</small></span>
        <span className="tb-track" aria-hidden><i className="tb-fill" /></span>
        <button id="lnd-tour-stop" type="button" aria-label="Stop the tour"><svg viewBox="0 0 12 12" aria-hidden><path d="M3 3l6 6M9 3 3 9" /></svg></button>
      </div>
      <div id="lnd-cur" aria-hidden><i /></div>
      <div className="lnd-main">{stations.map((s) => render[s])}</div>
      {children}
      <LandingShell config={config} />
    </div>
  );
}

/** Station 6's insignia: a benzene-ring emblem round the active way's icon (the shell switches the icon with the tabs). */
const WAY_ICONS = [ShoppingCart, FileText, Search, Tag];
function WayEmblem({ count, active }: { count: number; active: number }) {
  const hex = Array.from({ length: 6 }, (_, k) => {
    const a = ((-90 + k * 60) * Math.PI) / 180;
    return [Math.round((120 + Math.cos(a) * 84) * 100) / 100, Math.round((120 + Math.sin(a) * 84) * 100) / 100] as const;
  });
  return (
    <div className="ways-rank" aria-hidden>
      {/* three stacked layers: the spins run on the compositor (a whole layer turned), never as an SVG repaint */}
      <div className="we-frame">
        <div className="we-glow" />
        <svg className="we-l we-ring" viewBox="0 0 240 240">
          <defs>
            <linearGradient id="we-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#a4e335" /><stop offset="1" stopColor="#2fd6c3" /></linearGradient>
          </defs>
          <circle cx="120" cy="120" r="110" fill="none" stroke="url(#we-g)" strokeWidth="1.2" strokeDasharray="2 7" />
          <circle cx="230" cy="120" r="3.5" fill="#a4e335" />
        </svg>
        <svg className="we-l we-hex" viewBox="0 0 240 240">
          <polygon points={hex.map((p) => p.join(',')).join(' ')} fill="none" stroke="url(#we-g)" strokeWidth="2.4" strokeLinejoin="round" />
          <circle cx="120" cy="120" r="54" fill="none" stroke="url(#we-g)" strokeWidth="1.4" strokeOpacity=".7" />
          {hex.map(([x, y], k) => <circle key={k} cx={x} cy={y} r={k % 2 ? 4.5 : 6} fill="url(#we-g)" />)}
        </svg>
      </div>
      {WAY_ICONS.slice(0, Math.max(1, count)).map((Icon, i) => (
        <span key={i} className={i === active ? 'we-ico on' : 'we-ico'} data-way-emb={i}><Icon /></span>
      ))}
    </div>
  );
}

/** Station 5's live replica of the buying panel (sample data; the shell plays it with a ghost cursor). */
function BuyDemo({ product, note }: { product: DemoProduct | null; note: string }) {
  const title = product?.title ?? 'Agilent 1260 Infinity HPLC system';
  const brand = product?.brand ?? 'Agilent';
  return (
    <div className="app-demo" id="app-demo" role="group" aria-label="Buying panel demo">
      <div className="ad-win">
        <div className="ad-dots" aria-hidden><i /><i /><i /></div>
        <nav className="ad-side" aria-label="Demo navigation">
          <span className="ad-logo" aria-hidden>
            <svg viewBox="0 0 64 46"><g fill="url(#l2d-mark-grad)"><circle cx="8" cy="31" r="2.4" /><circle cx="17" cy="22" r="3.6" /><circle cx="27" cy="11" r="6.2" /><circle cx="38" cy="16" r="4.4" /><circle cx="47" cy="24" r="3.2" /><circle cx="55" cy="31" r="2.2" /></g></svg>
          </span>
          <button type="button" tabIndex={-1}>Dashboard</button>
          <button type="button" tabIndex={-1} className="on">Quotes</button>
          <button type="button" tabIndex={-1}>Orders</button>
          <button type="button" tabIndex={-1}>Messages</button>
        </nav>
        <div className="ad-main">
          <div className="ad-head">
            <div>
              <small>QUOTE Q-2026-0142</small>
              <b>{title}</b>
              <span>{brand}{product?.category ? ` · ${product.category}` : ''}</span>
            </div>
            <span className="ad-status" id="ad-status">Requested</span>
          </div>
          <div className="ad-photo">
            {product?.image && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={img(product.image, 384) ?? undefined} alt="" loading="lazy" />
            )}
          </div>
          <ol className="ad-timeline" id="ad-timeline">
            <li data-step="0"><i /><b>Quote requested</b><small>You asked for this instrument</small></li>
            <li data-step="1"><i /><b>Quote received</b><small>Itemised quote + proforma</small></li>
            <li data-step="2"><i /><b>Quote accepted</b><small>You confirm the quote</small></li>
            <li data-step="3"><i /><b>Proforma paid</b><small>Payment confirmed</small></li>
            <li data-step="4"><i /><b>Shipped</b><small>On its way to your lab</small></li>
          </ol>
          <div className="ad-offer" id="ad-offer">
            <div className="ad-offer-row"><span>Instrument as listed</span><em>1 ×</em></div>
            <div className="ad-offer-row"><span>Packing &amp; shipping</span><em>incl.</em></div>
            <div className="ad-offer-row ad-total"><span>Quote total</span><em>sample</em></div>
            <div className="ad-actions">
              <button type="button" tabIndex={-1} className="ad-accept" id="ad-accept">Accept quote</button>
              <button type="button" tabIndex={-1} className="ad-decline">Ask a question</button>
            </div>
          </div>
        </div>
        <div className="ad-toast" id="ad-toast" role="status" />
      </div>
      <span className="ad-cursor" id="ad-cursor" aria-hidden><svg viewBox="0 0 24 24"><path d="M5 3l14 8-6.2 1.6L9.5 19z" /></svg></span>
      <p className="ad-note">{note}</p>
    </div>
  );
}
