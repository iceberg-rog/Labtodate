import Link from 'next/link';
import { ArrowRight, ArrowUpRight, Check, FileText, LayoutGrid, Plus, Search, ShoppingCart, Tag } from 'lucide-react';
import { SearchTypeahead } from '@/components/site/SearchTypeahead';
import { CategoryIcon } from '@/components/home/CategoryIcon';
import { type GeoPoint, type HomeContent, type HomeStation, countText, searchPlaceholderFor } from '@/lib/home-sections';
import type { DemoProduct, StationCategory } from '@/lib/home-landing-data';
import { LandingShell } from './LandingShell';
import type { LandingConfig } from './engine/shell';
import './landing.css';

/** Scroll length of each pinned station (the Shelter landing's --h). */
const HEIGHT: Record<HomeStation, string> = { intro: '180vh', hero: '120vh', categories: '430vh', suppliers: '150vh', process: '125vh', ways: '120vh', cta: '150vh' };
const pad = (n: number) => String(n).padStart(2, '0');

function splitAccent(text: string): [string, string] {
  const m = text.trim().match(/^(.*[.!?])\s+([^.!?]+[.!?]?)$/);
  return m ? [m[1], m[2]] : ['', text];
}

export interface LandingProps {
  /** The stations shown, in their order (Admin → Homepage). */
  stations: HomeStation[];
  content: HomeContent;
  categories: StationCategory[];
  listings: number;
  demo: DemoProduct | null;
  /** The globe's hub (Admin → Homepage, else the company city). */
  hub: GeoPoint;
  sourcingNote: string;
  children?: React.ReactNode; // optional extra modules, after the stations
}

/**
 * The homepage, built on the Shelter landing's structure: pinned scroll
 * stations (each .sec is --h tall; its .stick panel stays on screen while the
 * scroll drives that station's 3D), one fixed WebGL canvas, a section rail,
 * HUD frame + meta line, the auto tour and the reveal (.rv) system. Every
 * station, item and text is server-rendered from Admin → Homepage; every
 * category in the list, on the cards and in the no-WebGL fallback is a real
 * link. LandingShell adds the behaviour and loads the 3D scene after the
 * first paint.
 */
export function Landing({ stations, content: c, categories, listings, demo, hub, sourcingNote, children }: LandingProps) {
  const site = c.site;
  const word = c.introWord || site;
  const tagAt = c.introTagline.indexOf(site);
  const ways = c.ways;
  const active = c.waysStart;
  const [ctaLead, ctaAccent] = splitAccent(c.ctaHeading);
  // the instruments' cards (scene.js: the card helix round the formula column): the category's photo seen through frosted
  // glass, its leading brands above the title and its live count under it; a click on the card in focus opens `href`
  const CARD_C: [string, string][] = [['#a4e335', '#0b2a1c'], ['#2fd6c3', '#062a28'], ['#7fd11f', '#0f2a14'], ['#14b8a6', '#05242a'], ['#d4f56a', '#1a2a0c']];
  const img = (src: string | null, w: number) => (src ? `/_next/image?url=${encodeURIComponent(src)}&w=${w}&q=75` : null);
  const config: LandingConfig = {
    links: {},
    games: categories.map((k, i) => ({
      name: k.name, slug: k.slug, href: k.href, c: CARD_C[i % CARD_C.length], plat: k.brands.slice(0, 3),
      fa: countText(c.catCount, k.count), wide: img(k.image, 828), artSm: img(k.image, 640),
    })),
    text: { outro: c.outroWord, globe_labs: c.netLabs, geo_node: hub.label },
    hub,
    lanes: c.netLanes,
  };
  const first = categories[0];
  const [openBefore, openAfter] = c.catOpen.includes('{NAME}') ? c.catOpen.split('{NAME}', 2) : [c.catOpen, null];
  const next = stations[stations.indexOf('intro') + 1];

  const section = (id: HomeStation, body: React.ReactNode, extra: React.HTMLAttributes<HTMLElement> & Record<string, unknown> = {}) => (
    <section key={id} id={id} className="sec" data-station={id} data-name={c.rail[id]} style={{ ['--h' as string]: HEIGHT[id] }} {...extra}>
      <div className="stick">{body}</div>
    </section>
  );

  const render: Record<HomeStation, () => React.ReactNode> = {
    intro: () => section('intro', (
      <>
        <div className="intro-word" aria-hidden data-word={word}>
          <span className="text-grad">{word}</span>
        </div>
        <p className="intro-tag rv">
          {tagAt >= 0 ? (<>{c.introTagline.slice(0, tagAt)}<strong>{site}</strong>{c.introTagline.slice(tagAt + site.length)}</>) : c.introTagline}
        </p>
        {next && <a href={`#${next}`} className="scroll-hint rv" style={{ ['--d' as string]: 2 }}><span className="mouse"><i /></span>{c.introScroll}</a>}
        <button id="lnd-tour-btn" className="tour-btn rv" style={{ ['--d' as string]: 3 }} type="button">
          <span className="tb-ring" aria-hidden><svg viewBox="0 0 12 12"><path d="M4 2.6v6.8L9.6 6z" /></svg></span>
          {c.tour[0]}
        </button>
      </>
    ), { 'aria-label': `${site} intro` }),

    hero: () => section('hero', (
      <>
        <div className="hero-copy">
          <span className="kicker rv">{c.heroBadge}</span>
          <h1 id="h-hero" className="rv" style={{ ['--d' as string]: 1 }}>
            {c.heroTitle} <span className="text-grad">{c.heroAccent}</span>
          </h1>
          <p className="lead rv" style={{ ['--d' as string]: 2 }}>{c.heroSubtitle}</p>
          <div className="hero-search glass-panel rv" style={{ ['--d' as string]: 3 }}>
            <SearchTypeahead size="lg" className="min-w-0 flex-1" placeholder={c.searchPlaceholder || searchPlaceholderFor(c.popular)} />
            <Link prefetch={false} href={c.heroBrowse[1]} className="btn btn-p">{c.heroBrowse[0]} <ArrowRight className="h-4 w-4" /></Link>
          </div>
          <div className="cta-row rv" style={{ ['--d' as string]: 4 }}>
            <Link prefetch={false} href={c.heroSource[1]} className="btn btn-g">{c.heroSource[0]} <ArrowRight className="h-4 w-4" /></Link>
            <Link prefetch={false} href={c.heroSell[1]} className="btn-link">{c.heroSell[0]}</Link>
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

    categories: () => section('categories', (
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
          {/* every item is a link to its category (or the chosen listing); keyboard focus also turns the cards to it */}
          <ol className="wk-list rv" style={{ ['--d' as string]: 2 }} id="game-list">
            {categories.map((k, i) => (
              <li key={k.slug}>
                <a href={k.href} data-i={i} className={i === 0 ? 'on' : ''} aria-current={i === 0 ? 'true' : undefined}>
                  <span className="ar" aria-hidden>&lt;-</span>
                  <CategoryIcon name={k.icon} className="ic" />
                  <span className="nm">{k.name}</span>
                  <em aria-label={countText(c.catCount, k.count)}>{pad(k.count).padStart(3, '0')}</em>
                </a>
              </li>
            ))}
          </ol>
          {/* a plain <a>: the shell points it at the category in focus, and that href is the one followed (a next/link would
              navigate to the href it was rendered with) */}
          <a id="wk-open" href={first?.href ?? c.catAll[1]} className="wk-open rv" style={{ ['--d' as string]: 2 }}>
            {openAfter === null ? openBefore : <>{openBefore}<b id="wk-open-name">{first?.name ?? ''}</b>{openAfter}</>} <ArrowRight className="h-3.5 w-3.5" />
          </a>
          <div className="wk-links rv" style={{ ['--d' as string]: 3 }}>
            <Link prefetch={false} className="wk-tile" href={c.catAll[1]}>
              <LayoutGrid aria-hidden />
              <span><b>{c.catAll[0]}</b><small>{c.catAllSub.replaceAll('{N}', listings.toLocaleString('en-US'))}</small></span>
              <ArrowUpRight className="go" aria-hidden />
            </Link>
            <Link prefetch={false} className="wk-tile alt" href={c.catAsk[1]}>
              <Plus aria-hidden />
              <span><b>{c.catAsk[0]}</b><small>{c.catAskSub}</small></span>
              <ArrowUpRight className="go" aria-hidden />
            </Link>
          </div>
        </div>
        {/* without WebGL: the first cards as plain links (the list above holds them all) */}
        <div className="wk-fallback" aria-hidden>
          {categories.slice(0, 3).map((k) => (
            <a key={k.slug} href={k.href} className="wk-fcard" tabIndex={-1}>
              {k.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/_next/image?url=${encodeURIComponent(k.image)}&w=640&q=75`} alt="" loading="lazy" />
              )}
              <b><CategoryIcon name={k.icon} className="ic" />{k.name}</b>
            </a>
          ))}
        </div>
      </>
    ), { 'aria-labelledby': 'h-games' }),

    suppliers: () => section('suppliers', (
      <>
        <div className="geo" id="geo" aria-hidden />
        <div className="route-copy">
          <h2 id="h-route" className="rv" style={{ ['--d' as string]: 1 }}>
            {c.netTitle} <span className="text-grad">{c.netAccent}</span>
          </h2>
          <p className="lead rv" style={{ ['--d' as string]: 2 }}>{c.netSubtitle}</p>
          <ol className="steps rv" style={{ ['--d' as string]: 3 }}>
            {c.netSteps.map((s, i) => (
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

    process: () => section('process', (
      <>
        <div className="app-copy">
          <h2 id="h-app" className="rv" style={{ ['--d' as string]: 1 }}>
            {c.demoTitle} <span className="text-grad">{c.demoAccent}</span>
          </h2>
          <p className="lead rv" style={{ ['--d' as string]: 2 }}>{c.demoLead}</p>
          <ul className="app-feats">
            {c.demoBullets.map((b, i) => (
              <li key={i} className="rv" style={{ ['--d' as string]: 3 + i }}><Check aria-hidden /><span><b>{b.title}</b>{b.text && <> — {b.text}</>}</span></li>
            ))}
          </ul>
          <div className="cta-row rv" style={{ ['--d' as string]: 3 + c.demoBullets.length }}>
            <Link prefetch={false} href={c.demoCta[1]} className="btn btn-p">{c.demoCta[0]} <ArrowRight className="h-4 w-4" /></Link>
          </div>
        </div>
        <BuyDemo product={demo} c={c} />
      </>
    ), { 'aria-labelledby': 'h-app' }),

    ways: () => section('ways', (
      <>
        <div className="ways-sky" aria-hidden><i className="w-beam b0" /><i className="w-beam b1" /><i className="w-floor" /></div>
        <div className="ways-head">
          <h2 id="h-ways" className="rv" style={{ ['--d' as string]: 1 }}>
            {c.waysTitle} <span className="text-grad">{c.waysAccent}</span>
          </h2>
          <p className="lead rv" style={{ ['--d' as string]: 2 }}>{c.waysLead}</p>
        </div>
        {/* one way: no tabs, its card alone */}
        {ways.length > 1 && (
          <div className="ways-tabs rv" style={{ ['--d' as string]: 2 }} role="tablist" aria-label="Ways to buy">
            {ways.map((w, i) => (
              <button key={w.title} type="button" role="tab" id={`way-tab-${i}`} aria-controls={`way-${i}`} aria-selected={i === active} tabIndex={i === active ? 0 : -1} data-way={i} className={i === active ? 'on' : ''}>
                {w.title}{w.tag && <em>{w.tag}</em>}
              </button>
            ))}
          </div>
        )}
        {ways.length > 0 && (
          <div className="ways-deal glass-panel rv" style={{ ['--d' as string]: 3 }}>
            <span className="hud-label ways-code" id="ways-code">{`WAY ${pad(active + 1)} // ${ways[active]?.tag.toUpperCase() ?? ''}`}</span>
            <WayEmblem count={ways.length} active={active} />
            {ways.map((w, i) => (
              <div key={w.title} className={`ways-panel ${i === active ? 'on' : ''}`} id={`way-${i}`} {...(ways.length > 1 ? { role: 'tabpanel', 'aria-labelledby': `way-tab-${i}` } : {})} hidden={i !== active}>
                <h3>{w.title}</h3>
                <p>{w.text}</p>
                <ul>{w.bullets.map((b) => <li key={b}><Check aria-hidden />{b}</li>)}</ul>
                <Link prefetch={false} href={w.href} className="btn btn-p">{w.cta} <ArrowRight className="h-4 w-4" /></Link>
              </div>
            ))}
          </div>
        )}
        {c.waysChips.length > 0 && (
          <ul className="ways-chips rv" style={{ ['--d' as string]: 4 }}>
            {c.waysChips.map((t) => <li key={t}><Check aria-hidden />{t}</li>)}
          </ul>
        )}
      </>
    ), { 'aria-labelledby': 'h-ways' }),

    cta: () => section('cta', (
      <>
        <div className="play-word" aria-hidden data-word={c.outroWord}><span className="text-grad">{c.outroWord}</span></div>
        <div className="play-copy">
          <h2 id="h-play" className="rv" style={{ ['--d' as string]: 1 }}>
            {ctaLead}{ctaLead && <br />}<span className="text-grad">{ctaAccent}</span>
          </h2>
          <p className="lead rv" style={{ ['--d' as string]: 2 }}>{c.ctaSubtitle}</p>
          <div className="cta-row rv" style={{ ['--d' as string]: 3 }}>
            <Link prefetch={false} href={c.ctaPrimary[1]} className="btn btn-p">{c.ctaPrimary[0]} <ArrowRight className="h-4 w-4" /></Link>
            <Link prefetch={false} href={c.ctaSecondary[1]} className="btn btn-g">{c.ctaSecondary[0]}</Link>
          </div>
          {sourcingNote && <p className="play-note rv" style={{ ['--d' as string]: 4 }}>{sourcingNote}</p>}
        </div>
      </>
    ), { 'aria-labelledby': 'h-play' }),
  };

  return (
    <div id="lnd" className="lnd">
      <canvas id="gl" aria-hidden />
      {stations.includes('intro') && <div className="poster" id="poster" data-word={word} aria-hidden><canvas /></div>}
      <div className="lnd-nogl" aria-hidden />
      <div className="lnd-hud" aria-hidden><i className="c c1" /><i className="c c2" /><i className="c c3" /><i className="c c4" /></div>
      <nav className="lnd-rail" aria-label="Sections">
        {stations.map((s, i) => (
          <button key={s} type="button" data-go={s}><i /><span>{pad(i + 1)} {c.rail[s]}</span></button>
        ))}
      </nav>
      <div className="lnd-meta" aria-hidden><span>{c.hudMeta}</span><span id="lnd-sec">{`SEC 01 // ${c.rail[stations[0]] ?? ''}`}</span></div>
      <div className="tour-bar" id="lnd-tour-bar" role="status" aria-hidden="true">
        <span className="tb-dot" aria-hidden />
        <span className="tb-t">{c.tour[0]}{c.tour[1] && <small>{c.tour[1]}</small>}</span>
        <span className="tb-track" aria-hidden><i className="tb-fill" /></span>
        <button id="lnd-tour-stop" type="button" aria-label="Stop the tour"><svg viewBox="0 0 12 12" aria-hidden><path d="M3 3l6 6M9 3 3 9" /></svg></button>
      </div>
      <div id="lnd-cur" aria-hidden><i /></div>
      <div className="lnd-main">{stations.map((s) => render[s]())}</div>
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

/**
 * Station 5's live replica of the buying panel (sample data, said so under it; the shell plays it with a ghost cursor).
 * The steps, statuses and pop-up messages come from Admin → Homepage (data-label / data-toast for the shell), in the real
 * order: written offer, acceptance and proforma, payment and VAT invoice, shipment.
 */
function BuyDemo({ product, c }: { product: DemoProduct | null; c: HomeContent }) {
  const title = product?.title ?? c.demoSample;
  const meta = [product?.brand, product?.category].filter(Boolean).join(' · ');
  const rows = c.demoOffer.slice(0, -1);
  const total = c.demoOffer[c.demoOffer.length - 1];
  return (
    <div className="app-demo" id="app-demo" role="group" aria-label="Buying panel demo">
      <div className="ad-win">
        <div className="ad-dots" aria-hidden><i /><i /><i /></div>
        <nav className="ad-side" aria-label="Demo navigation">
          <span className="ad-logo" aria-hidden>
            <svg viewBox="0 0 64 46"><g fill="url(#l2d-mark-grad)"><circle cx="8" cy="31" r="2.4" /><circle cx="17" cy="22" r="3.6" /><circle cx="27" cy="11" r="6.2" /><circle cx="38" cy="16" r="4.4" /><circle cx="47" cy="24" r="3.2" /><circle cx="55" cy="31" r="2.2" /></g></svg>
          </span>
          {c.demoNav.map((n, i) => <button key={`${n}-${i}`} type="button" tabIndex={-1} className={i === 1 ? 'on' : undefined}>{n}</button>)}
        </nav>
        <div className="ad-main">
          <div className="ad-head">
            <div>
              <small>{c.demoRef}</small>
              <b>{title}</b>
              {meta && <span>{meta}</span>}
            </div>
            <span className="ad-status" id="ad-status">{c.demoSteps[0]?.status}</span>
          </div>
          <div className="ad-photo">
            {product?.image && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/_next/image?url=${encodeURIComponent(product.image)}&w=384&q=75`} alt="" loading="lazy" />
            )}
          </div>
          <ol className="ad-timeline" id="ad-timeline">
            {c.demoSteps.map((s, i) => (
              <li key={i} data-step={i} data-label={s.status} data-toast={s.toast}><i /><b>{s.title}</b>{s.text && <small>{s.text}</small>}</li>
            ))}
          </ol>
          <div className="ad-offer" id="ad-offer">
            {rows.map(([l, v], i) => <div key={i} className="ad-offer-row"><span>{l}</span><em>{v}</em></div>)}
            {total && <div className="ad-offer-row ad-total"><span>{total[0]}</span><em>{total[1]}</em></div>}
            <div className="ad-actions">
              <button type="button" tabIndex={-1} className="ad-accept" id="ad-accept">{c.demoButtons[0]}</button>
              {c.demoButtons[1] && <button type="button" tabIndex={-1} className="ad-decline">{c.demoButtons[1]}</button>}
            </div>
          </div>
        </div>
        <div className="ad-toast" id="ad-toast" role="status" />
      </div>
      <span className="ad-cursor" id="ad-cursor" aria-hidden><svg viewBox="0 0 24 24"><path d="M5 3l14 8-6.2 1.6L9.5 19z" /></svg></span>
      <p className="ad-note">{c.demoNote}</p>
    </div>
  );
}
