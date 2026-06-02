/**
 * Phase 10 + 11 content seed.
 * Idempotent. Run after main seed (categories/users exist).
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ADMIN_ID = 'seed_user_admin';

const BLOG_POSTS = [
  {
    slug: 'buying-refurbished-hplc-checklist',
    title: 'How to Buy a Refurbished HPLC System: The Complete 2026 Inspection Checklist',
    excerpt:
      'A refurbished HPLC can cut 40–60% off list price without compromising data quality — if you inspect it correctly. This is the 18-point checklist our procurement team uses on every incoming system.',
    body: `
      <p class="lead">A refurbished high-performance liquid chromatography (HPLC) system can deliver the same chromatographic performance as a new instrument at 40–60% of the list price. The difference between a smart purchase and an expensive mistake is not the brand or the age of the system — it is the rigour of the inspection before money changes hands. This guide walks through every checkpoint our procurement engineers run before approving an HPLC for resale.</p>

      <h2>Why refurbished HPLC is a defensible procurement decision</h2>
      <p>An HPLC is a mechanically conservative instrument. The pump, autosampler, column oven and detector are mature technologies that have not changed fundamentally in fifteen years. A 2014 Agilent 1260 Infinity running a freshly rebuilt pump head produces chromatograms that are analytically indistinguishable from a 2024 unit. What degrades is not the design — it is the wear components. Every item on the checklist below targets a specific wear component or a piece of documentation that proves it was addressed.</p>
      <div class="callout"><p><strong>Rule of thumb:</strong> the value of a refurbished HPLC is inversely proportional to the number of checklist items the seller cannot answer in writing. One unanswered item is normal. Three is a negotiating lever. Five or more, walk away.</p></div>

      <h2>The pre-purchase inspection checklist</h2>

      <h3>1. Pump pressure-pulsation report</h3>
      <p>Request a pulsation test at three flow rates (0.5, 1.0 and 2.0 mL/min). A correctly rebuilt binary or quaternary pump should hold pulsation below 0.5% at 1 mL/min with a backpressure restrictor installed. High pulsation is the single most common cause of baseline noise and irreproducible retention times.</p>

      <h3>2. Pump seal and piston replacement record</h3>
      <p>Plunger seals are consumables with a 6–12 month service life under normal use. Ask for the date the seals were last replaced and whether the sapphire pistons were inspected for scoring. Scored pistons destroy new seals within weeks.</p>

      <h3>3. Detector lamp hours</h3>
      <p>A UV-Vis or diode-array deuterium lamp has a useful life of roughly 2,000 hours. Demand the current lamp-hour counter reading. Anything above 1,500 hours should be replaced by the seller before shipment or explicitly discounted from the price.</p>

      <h3>4. Detector wavelength accuracy and noise</h3>
      <p>Request a holmium oxide wavelength-accuracy certificate and a short-term noise/drift report. Wavelength accuracy should be within ±1 nm; baseline noise at 254 nm should be below 1×10⁻⁴ AU for a healthy detector.</p>

      <h3>5. Autosampler injection precision</h3>
      <p>The autosampler is the most mechanically complex module. Ask for a six-replicate injection-precision result. Area %RSD should be under 1.0% for a standard sample loop. Carryover should be below 0.05%.</p>

      <h3>6. Column oven temperature stability</h3>
      <p>Retention-time reproducibility depends on a stable column compartment. Stability should be within ±0.15 °C of setpoint. A drifting oven is usually a failed Peltier element — an expensive repair you do not want to inherit.</p>

      <h3>7. Solvent degasser performance</h3>
      <p>Vacuum degassers degrade silently. The symptom is sporadic baseline spikes and pump cavitation. Confirm the degasser was tested under vacuum and holds specification.</p>

      <h3>8. Mixer and gradient accuracy</h3>
      <p>For gradient methods, request a step-gradient linearity test (a caffeine or acetone tracer ramp). Deviation from the programmed composition should be under 1% absolute across the gradient.</p>

      <h3>9–18. The documentation and logistics checklist</h3>
      <table>
        <thead><tr><th>#</th><th>Item</th><th>What &ldquo;good&rdquo; looks like</th></tr></thead>
        <tbody>
          <tr><td>9</td><td>Tubing &amp; fitting replacement</td><td>All capillaries and PEEK fittings replaced; documented</td></tr>
          <tr><td>10</td><td>Firmware / software version</td><td>Current, with a transferable software licence in writing</td></tr>
          <tr><td>11</td><td>Full service history</td><td>Timestamped log from the previous owner or OEM</td></tr>
          <tr><td>12</td><td>Calibration traceability</td><td>Certificates traceable to a national standard</td></tr>
          <tr><td>13</td><td>Warranty</td><td>90 days minimum, parts and labour, in the contract</td></tr>
          <tr><td>14</td><td>Decommission certificate</td><td>Proof the system was properly retired and decontaminated</td></tr>
          <tr><td>15</td><td>Decontamination statement</td><td>Signed; critical if the system ran biological samples</td></tr>
          <tr><td>16</td><td>Crating &amp; shipping insurance</td><td>Custom crate, insured to full replacement value</td></tr>
          <tr><td>17</td><td>Installation / IQ-OQ</td><td>Stated explicitly as included or quoted separately</td></tr>
          <tr><td>18</td><td>Return / acceptance window</td><td>A written period to run your own acceptance samples</td></tr>
        </tbody>
      </table>

      <h2>Installation qualification: the test that actually matters</h2>
      <p>Every checklist item above is a leading indicator. The lagging indicator — the one that proves the system works for <em>your</em> methods — is running your own validated method on day one. Negotiate an acceptance window into the purchase contract. Run a system suitability test with your real mobile phase, your column and your reference standard. If the system meets your existing SST limits (resolution, tailing factor, plate count, retention-time RSD), the refurbishment was real.</p>

      <h2>Frequently asked questions</h2>
      <div class="faq">
        <h3>Is a refurbished HPLC reliable enough for a regulated (GMP/GLP) lab?</h3>
        <p>Yes, provided it ships with traceable calibration certificates and you perform full IQ/OQ/PQ on installation. Regulators care about qualification evidence, not the instrument's purchase date.</p>
        <h3>How much should I expect to save versus a new system?</h3>
        <p>For mainstream analytical HPLC (Agilent 1100/1200/1260, Waters Alliance, Shimadzu Prominence), 40–60% off new OEM list is the normal range for a properly refurbished, warrantied unit.</p>
        <h3>What is the single biggest red flag?</h3>
        <p>A seller who cannot produce a pump pressure-pulsation report or detector lamp-hour reading. These are the two cheapest tests to run and the two most expensive components to repair — a refurbisher who skipped them skipped the rebuild.</p>
        <h3>Should I buy with or without a column?</h3>
        <p>Buy the hardware on its own merits and source columns separately. A bundled column is often near end-of-life and inflates the headline value of the deal.</p>
      </div>

      <h2>Key takeaways</h2>
      <ul>
        <li>The instrument's age is almost irrelevant; the condition of its wear components is everything.</li>
        <li>Demand the pump pulsation report and detector lamp hours before anything else.</li>
        <li>Put a real acceptance window — running your own method — into the contract.</li>
        <li>Treat missing documentation as a price-negotiation lever, not a deal-breaker on its own.</li>
      </ul>
      <p>Browse warrantied refurbished HPLC systems with full inspection documentation in the <a href="/marketplace?category=hplc">lab2date marketplace</a>.</p>
    `,
    category: 'Buying guide',
    illustration: 'hplc',
    coverGradient: 'from-[hsl(168_60%_22%)] via-[hsl(168_50%_30%)] to-[hsl(82_60%_55%)]',
    readMinutes: 14,
  },
  {
    slug: 'mass-spec-cost-breakdown-2026',
    title: 'Mass Spectrometer Total Cost of Ownership: A 2026 Breakdown',
    excerpt:
      'The number on the OEM quote is rarely what a mass spectrometer actually costs. Here is the real five-year total cost of ownership, line by line, with the figures vendors leave off the proposal.',
    body: `
      <p class="lead">A €600,000 mass spectrometer almost never costs €600,000. By year five, the capital price is typically less than half of what the instrument has actually consumed in budget. This analysis breaks down the real five-year total cost of ownership (TCO) for LC-MS/MS and high-resolution accurate-mass systems, using figures we see on live procurement quotes in 2026 — including the lines original-equipment manufacturers (OEMs) tend to leave off the proposal.</p>

      <h2>Why the quoted price is the wrong number</h2>
      <p>Procurement decisions anchored to capital price systematically underestimate the cost of mass spectrometry. The instrument is a platform; the recurring cost of running it — service, consumables, gases, and the productivity lost to downtime — compounds every year. A 10% difference in capital price is frequently erased by a single year's difference in service-contract terms.</p>

      <h2>The five-year cost breakdown</h2>
      <table>
        <thead><tr><th>Cost category</th><th>Share of 5-yr TCO</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td>Capital acquisition</td><td>~48%</td><td>Net price after negotiation</td></tr>
          <tr><td>Service contract</td><td>~24%</td><td>8–12% of instrument value per year</td></tr>
          <tr><td>Consumables</td><td>~9%</td><td>Sources, capillaries, pump oil, columns</td></tr>
          <tr><td>Gases &amp; utilities</td><td>~6%</td><td>Nitrogen generation, argon, power</td></tr>
          <tr><td>Downtime / lost throughput</td><td>~13%</td><td>Uptime gap vs. theoretical capacity</td></tr>
        </tbody>
      </table>

      <h3>1. Capital acquisition — about 48%</h3>
      <p>The negotiated net price. For a refurbished triple-quadrupole, expect 45–55% of new OEM list. For Orbitrap- or Q-TOF-class high-resolution instruments, properly refurbished units land at 40–50% of new. The capital line is also the most negotiable: trade-ins, end-of-quarter timing and multi-instrument bundling routinely move it 10–15%.</p>

      <h3>2. Service contract — about 24%</h3>
      <p>This is the line that quietly dominates TCO. OEM full-coverage contracts run 8–12% of instrument value <em>every year</em>. Over five years that is 40–60% of the original capital price, paid again. Independent service organisations (ISOs) typically undercut OEM contracts by 30–40%. The trade-off is spare-parts lead time and, for some platforms, restricted access to OEM diagnostic software.</p>
      <div class="callout"><p><strong>Negotiation lever:</strong> the first-year service contract is almost always bundled into the capital deal at a discount, then resets to list at renewal. Negotiate years 2–5 pricing <em>before</em> you sign for the instrument, not at renewal when you have no leverage.</p></div>

      <h3>3. Consumables — about 9%</h3>
      <p>Ion-source components, capillaries, calibrant, vacuum-pump oil and analytical columns. Individually small, collectively relentless, and almost never modelled at quote stage. Consumables are the line that dominates year 2–3 operating budgets and surprises labs that budgeted only for capital and service.</p>

      <h3>4. Gases and utilities — about 6%</h3>
      <p>Nitrogen is the hidden recurring cost of LC-MS. A bench nitrogen generator has a capital and maintenance cost of its own; bulk-liquid nitrogen has a delivery and boil-off cost. Add argon for collision cells and the electrical load of roughing and turbo pumps running continuously.</p>

      <h3>5. Downtime and lost throughput — about 13%</h3>
      <p>The most under-counted cost of all. Industry-typical uptime is around 93% for new systems and 88% for refurbished ones. That 5-point gap is roughly five working weeks of lost sample throughput per year. For a contract lab billing instrument time, this line can exceed the service contract.</p>

      <h2>Refurbished versus new: the honest comparison</h2>
      <p>A refurbished instrument lowers the capital line dramatically but slightly widens the downtime line. The net effect over five years is still strongly favourable — the capital saving (40–55% of the largest single line) far outweighs the few extra days of downtime, <em>provided</em> the refurbished unit ships with a real warranty and a credible service plan. The decision is not "new versus refurbished"; it is "what total cost am I committing to over five years, and is the service plan credible?"</p>

      <h2>Frequently asked questions</h2>
      <div class="faq">
        <h3>What percentage of a mass spec's lifetime cost is the service contract?</h3>
        <p>Roughly a quarter of five-year TCO, and often more than half the capital price again over five years. It is the highest-leverage line to negotiate.</p>
        <h3>Are independent service organisations safe for high-end instruments?</h3>
        <p>For triple-quads and older Q-TOFs, yes — the ISO market is mature. For the newest high-resolution platforms, OEM diagnostic-software lockouts can limit what an ISO can do; verify software access before committing.</p>
        <h3>How do I model TCO before I buy?</h3>
        <p>Take the net capital price, add 10% per year for service, 4% per year for consumables and gases combined, and value your expected downtime at your fully loaded instrument-hour rate. Sum over five years.</p>
        <h3>Does a refurbished system really cost more in downtime?</h3>
        <p>Marginally — about a 5-point uptime gap on average. With a warrantied unit and a proactive service plan that gap narrows substantially and never approaches the capital saving.</p>
      </div>

      <h2>Key takeaways</h2>
      <ul>
        <li>Capital price is under half of true five-year cost — model the whole picture before deciding.</li>
        <li>The service contract is the highest-leverage negotiation point; lock in years 2–5 pricing up front.</li>
        <li>Downtime is a real, quantifiable cost; value it at your loaded instrument-hour rate.</li>
        <li>Refurbished wins on TCO when, and only when, the service plan is credible.</li>
      </ul>
      <p>Compare warrantied refurbished mass spectrometers and request a full TCO model from the <a href="/marketplace?category=massspec">lab2date marketplace</a>.</p>
    `,
    category: 'Cost analysis',
    illustration: 'massspec',
    coverGradient: 'from-[hsl(82_55%_50%)] via-[hsl(168_55%_30%)] to-[hsl(168_70%_18%)]',
    readMinutes: 13,
  },
  {
    slug: 'centrifuge-rotor-compatibility-guide',
    title: 'Centrifuge Rotor Compatibility: The Complete Cross-Brand Guide',
    excerpt:
      'Mounting the wrong rotor is one of the most expensive — and most preventable — mistakes in a lab. A real incident, the physics behind why it happens, and a cross-brand compatibility matrix.',
    body: `
      <p class="lead">Centrifuge rotors look interchangeable. They are not. Mounting a rotor that was not validated for a specific drive is one of the most expensive preventable failures in a working lab, and it happens because the parts physically fit. This guide explains why cross-brand rotor swaps fail, walks through a real incident, and provides a compatibility matrix for the most common benchtop and floor-standing platforms.</p>

      <h2>A €74,000 lesson</h2>
      <p>In Q3 2025 a lab manager at a Dutch life-science park took delivery of a Beckman Coulter Avanti J-26 XPI floor centrifuge. The team had a shelf of Sorvall fixed-angle rotors from a decommissioned instrument and mounted one — it fit the spindle cleanly. The bearings seized within thirty minutes of the first run. Final cost: roughly €74,000 in drive and chamber repairs, plus a voided 90-day warranty because the failure was traced to an unapproved rotor.</p>
      <div class="callout"><p><strong>The core problem:</strong> a rotor that physically mounts is not a rotor that is mechanically valid. Fit tells you nothing about whether the drive can safely accelerate, balance and decelerate that mass.</p></div>

      <h2>Why cross-brand swaps fail — the physics</h2>
      <p>Three engineering parameters make rotors brand- and model-specific, and none of them is visible by eye:</p>
      <h3>Drive-shaft interface and torque transfer</h3>
      <p>Shaft diameters across brands are frequently within 0.5 mm of each other, so a rotor will seat. But the keyway geometry, taper angle and torque-transfer mechanism are designed as a matched pair with the drive. A mismatch concentrates shear stress at the hub during acceleration.</p>
      <h3>Imbalance detection and compensation</h3>
      <p>Modern drives detect imbalance and abort the run. The detection thresholds are calibrated to the inertial signature of approved rotors. An unrecognised rotor can defeat the safety logic — the drive does not know what "balanced" looks like for a mass it was never characterised against.</p>
      <h3>Speed and kinetic-energy derating</h3>
      <p>Maximum safe speed is a function of rotor mass, radius and material fatigue life. The drive's speed map is keyed to approved rotor part numbers. Spin an unapproved rotor and the kinetic-energy envelope the chamber was certified to contain may be exceeded — the failure mode is not "an error message", it is a containment event.</p>

      <h2>Cross-brand compatibility matrix</h2>
      <p>The only safe rule is: use rotors the centrifuge manufacturer explicitly lists for that exact drive model. The matrix below summarises the most common platforms our buyers ask about.</p>
      <table>
        <thead><tr><th>Centrifuge</th><th>Approved rotor families</th><th>Do not use</th></tr></thead>
        <tbody>
          <tr><td>Beckman Allegra X-30R</td><td>Beckman F2402H, F2403, S5700 series</td><td>Sorvall / Thermo rotors</td></tr>
          <tr><td>Beckman Avanti J-26 XPI</td><td>Beckman JLA, JA, JS series</td><td>Sorvall fixed-angle / Fiberlite</td></tr>
          <tr><td>Eppendorf 5810 R</td><td>Eppendorf A-4-81, F-34-6-38, S-4-104</td><td>Cross-brand (fits but invalid)</td></tr>
          <tr><td>Thermo Sorvall LYNX 6000</td><td>Sorvall TX, Fiberlite F-series</td><td>Beckman JLA / JS</td></tr>
          <tr><td>Thermo Sorvall ST 8</td><td>Sorvall TX-100S, M-20 microplate</td><td>Eppendorf / Beckman swing-out</td></tr>
        </tbody>
      </table>
      <p>This matrix is a starting point, not an authority. Always confirm against the current rotor-compatibility document for the exact drive serial-number range — manufacturers revise approved lists across production years of the same model name.</p>

      <h2>What to verify when buying a used centrifuge</h2>
      <ul>
        <li>The drive model <em>and</em> serial number, matched against the current approved-rotor list.</li>
        <li>The rotor's logbook: total accumulated run hours and de-rating status (rotors have a fatigue life and a mandatory retirement date).</li>
        <li>Inspection of the rotor bore and drive hub for corrosion or scoring.</li>
        <li>That any included rotor is on the approved list for the specific drive — not merely the same brand.</li>
      </ul>

      <h2>Frequently asked questions</h2>
      <div class="faq">
        <h3>Can I use a different-brand rotor if it physically fits the spindle?</h3>
        <p>No. Physical fit is meaningless for safety. Torque transfer, imbalance detection and the certified containment envelope are all keyed to specific approved rotor part numbers.</p>
        <h3>Do rotors expire?</h3>
        <p>Yes. Rotors have a fatigue-limited service life expressed in accumulated run hours and/or years. Aluminium rotors are de-rated to lower maximum speeds as they age, and have a mandatory retirement date in their logbook.</p>
        <h3>Is using an unapproved rotor really a safety issue, not just a warranty one?</h3>
        <p>It is both. The chamber containment certification assumes approved rotors. An over-speed failure with an unapproved rotor is a containment-breach risk, not just a repair bill.</p>
        <h3>What is the single best protection when buying used?</h3>
        <p>Match the drive serial number to the manufacturer's current approved-rotor list, and demand the rotor logbook. A seller who says "just use whatever rotor you have" is disqualifying themselves.</p>
      </div>

      <h2>Key takeaways</h2>
      <ul>
        <li>A rotor that fits is not a rotor that is safe — fit and validity are unrelated.</li>
        <li>Compatibility is keyed to the exact drive model and serial range, not the brand.</li>
        <li>Rotors have a finite, logged fatigue life; always demand the logbook on used purchases.</li>
        <li>An unapproved rotor is a containment-safety risk, not merely a warranty problem.</li>
      </ul>
      <p>Every centrifuge listed on lab2date includes its drive model and approved-rotor documentation — browse the <a href="/marketplace?category=centrifuge">centrifuge marketplace</a>.</p>
    `,
    category: 'Technical guide',
    illustration: 'centrifuge',
    coverGradient: 'from-[hsl(168_70%_18%)] via-[hsl(168_55%_30%)] to-[hsl(82_55%_50%)]',
    readMinutes: 11,
  },
];

const WIKI_ARTICLES = [
  {
    slug: 'what-is-hplc',
    title: 'What is HPLC?',
    category: 'Chromatography',
    body: `
      <p>High-Performance Liquid Chromatography (HPLC) separates compounds in a liquid mixture using a high-pressure pump to drive the sample through a packed column.</p>
      <h2>How it works</h2>
      <p>Sample is injected into a flowing mobile phase, passes through a column packed with a stationary phase, and separates based on each compound's affinity for stationary vs. mobile phase.</p>
      <h2>Common detector types</h2>
      <ul>
        <li><strong>UV-Vis</strong> — most common, measures absorption at 190-800 nm</li>
        <li><strong>DAD (Diode Array Detector)</strong> — UV across full spectrum simultaneously</li>
        <li><strong>FLD (Fluorescence)</strong> — for fluorescent compounds, much higher sensitivity</li>
        <li><strong>ELSD / CAD</strong> — for non-UV-absorbing compounds (carbohydrates, lipids)</li>
        <li><strong>MS</strong> — coupled to mass spec for definitive identification</li>
      </ul>
    `,
  },
  {
    slug: 'centrifuge-types',
    title: 'Centrifuge types explained',
    category: 'Centrifuges',
    body: `
      <p>Four broad categories based on max RPM and capacity:</p>
      <h2>Microcentrifuges</h2>
      <p>1.5-2.0 mL tubes, up to 21,000 × g. The workhorse for molecular biology.</p>
      <h2>Benchtop / Multipurpose</h2>
      <p>15-50 mL tubes, swing-out or fixed-angle, up to 30,000 × g.</p>
      <h2>Superspeed</h2>
      <p>Up to 100,000 × g. Used for organelle isolation, viral particles.</p>
      <h2>Ultracentrifuge</h2>
      <p>Up to 1,000,000 × g. Used for ribosomes, sub-cellular fractionation, density gradient separations.</p>
    `,
  },
];

const CASE_STUDIES = [
  {
    slug: 'pivot-park-40-percent-cost-savings',
    title: 'Pivot Park saved 40% on a Zeiss confocal versus distributor list price',
    customer: 'Pivot Park',
    outcomeMetric: '40% cost savings',
    excerpt: 'A €280k upfront save on a single instrument procurement, with the same warranty terms and faster delivery.',
    body: `
      <h2>The setup</h2>
      <p>Pivot Park needed a Zeiss LSM 980 confocal for a new live-cell imaging facility. OEM quote came in at €690,000 with 12-week delivery and €92k/year service contract.</p>
      <h2>The lab2date sourcing</h2>
      <p>Our team identified a 2021 LSM 980 from a Dutch academic lab that had upgraded to an Airyscan-equipped 9-series. The instrument had 1,200 h on the laser unit and full Zeiss service history.</p>
      <h2>The outcome</h2>
      <ul>
        <li>Final purchase: €410,000 (40% under OEM list)</li>
        <li>Delivery: 4 weeks vs. 12</li>
        <li>Warranty: 12 months independent + transferable Zeiss certifications</li>
        <li>Imaging core operational 8 weeks earlier than projected</li>
      </ul>
    `,
    illustration: 'microscope',
  },
  {
    slug: 'epoch-biodesign-discontinued-mass-spec-component',
    title: 'EPOCH BioDesign sourced a discontinued mass spec component in 11 days',
    customer: 'EPOCH BioDesign',
    outcomeMetric: '11-day sourcing',
    excerpt: 'A failed ion source on a 2014 Waters TQ-S would have meant a 6-month custom rebuild. Concierge sourcing found a working unit in Australia.',
    body: `
      <h2>The crisis</h2>
      <p>A Waters Xevo TQ-S ion source failed in mid-pipeline. Waters quoted 26-week lead time on the replacement (legacy part). EPOCH would have had to either rebuild internally or stall the project.</p>
      <h2>The search</h2>
      <p>Our sourcing team queried 84 suppliers in 6 countries. On day 9 we found a working source unit at a private analytical lab in Melbourne that had decommissioned the same instrument.</p>
      <h2>The result</h2>
      <p>Source unit cross-shipped via air freight, installed on day 14, full validation by day 17. Total elapsed time from request to operational: <strong>11 business days</strong>. Cost: 65% under OEM list.</p>
    `,
    illustration: 'massspec',
  },
];

const FACILITIES = [
  {
    slug: 'pivot-park-imaging-core',
    name: 'Pivot Park Imaging Core',
    city: 'Oss',
    country: 'Netherlands',
    description:
      'Confocal microscopy and live-cell imaging facility open to external researchers. Zeiss LSM 980 + Leica SP8 X. Includes dedicated image-analysis workstation and on-call technical support.',
    hourlyRateCents: 8500,
    dailyRateCents: 48000,
    capabilities: ['Confocal', 'Live-cell', 'Super-resolution', 'Image analysis'],
    illustration: 'microscope',
    ownerCompanySlug: 'pivot-park-instruments',
    isPublished: true,
  },
  {
    slug: 'biolab-refurb-test-lab',
    name: 'BioLab Refurb Test Bay',
    city: 'Berlin',
    country: 'Germany',
    description:
      'Open test bay for buyer evaluation of refurbished instruments. Run your own samples on a candidate instrument before committing to purchase. Includes Bio-Rad CFX, Beckman Allegra, Sartorius balances.',
    hourlyRateCents: 0,
    dailyRateCents: 0,
    capabilities: ['Evaluation', 'PCR', 'Centrifugation', 'Weighing'],
    illustration: 'pcr',
    ownerCompanySlug: 'biolab-refurb-gmbh',
    isPublished: true,
  },
  {
    slug: 'northeast-scientific-mass-spec-suite',
    name: 'Northeast Scientific Mass Spec Suite',
    city: 'Boston',
    country: 'USA',
    description:
      'Three fully-configured analytical bays available for rental: Orbitrap Exploris 240, Waters Xevo G3, Agilent 6470. Sample prep and method development included.',
    hourlyRateCents: 16500,
    dailyRateCents: 120000,
    capabilities: ['LC-MS', 'GC-MS', 'Method dev', 'Sample prep'],
    illustration: 'massspec',
    ownerCompanySlug: 'northeast-scientific',
    isPublished: true,
  },
];

async function main() {
  console.log('🌱 Seeding content (blog + wiki + case studies + facilities)...');

  for (const post of BLOG_POSTS) {
    await prisma.blogPost.upsert({
      where: { slug: post.slug },
      update: {
        title: post.title, excerpt: post.excerpt, body: post.body.trim(), category: post.category,
        illustration: post.illustration, coverGradient: post.coverGradient, readMinutes: post.readMinutes,
        status: 'PUBLISHED', publishedAt: new Date(),
      },
      create: {
        slug: post.slug, title: post.title, excerpt: post.excerpt, body: post.body.trim(),
        category: post.category, illustration: post.illustration, coverGradient: post.coverGradient,
        readMinutes: post.readMinutes, authorId: ADMIN_ID, status: 'PUBLISHED', publishedAt: new Date(),
      },
    });
  }

  for (const a of WIKI_ARTICLES) {
    await prisma.wikiArticle.upsert({
      where: { slug: a.slug },
      update: { title: a.title, body: a.body.trim(), category: a.category, status: 'PUBLISHED', publishedAt: new Date() },
      create: { slug: a.slug, title: a.title, body: a.body.trim(), category: a.category, authorId: ADMIN_ID, status: 'PUBLISHED', publishedAt: new Date() },
    });
  }

  for (const c of CASE_STUDIES) {
    await prisma.caseStudy.upsert({
      where: { slug: c.slug },
      update: {
        title: c.title, customer: c.customer, outcomeMetric: c.outcomeMetric,
        excerpt: c.excerpt, body: c.body.trim(), illustration: c.illustration,
        status: 'PUBLISHED', publishedAt: new Date(),
      },
      create: {
        slug: c.slug, title: c.title, customer: c.customer, outcomeMetric: c.outcomeMetric,
        excerpt: c.excerpt, body: c.body.trim(), illustration: c.illustration,
        status: 'PUBLISHED', publishedAt: new Date(),
      },
    });
  }

  const companies = Object.fromEntries(
    (await prisma.company.findMany()).map((c) => [c.slug, c.id]),
  );

  for (const f of FACILITIES) {
    const ownerId = f.ownerCompanySlug ? companies[f.ownerCompanySlug] : null;
    await prisma.labFacility.upsert({
      where: { slug: f.slug },
      update: {
        name: f.name, city: f.city, country: f.country, description: f.description,
        hourlyRateCents: f.hourlyRateCents, dailyRateCents: f.dailyRateCents,
        capabilities: f.capabilities, illustration: f.illustration,
        ownerCompanyId: ownerId, isPublished: f.isPublished,
      },
      create: {
        slug: f.slug, name: f.name, city: f.city, country: f.country, description: f.description,
        hourlyRateCents: f.hourlyRateCents, dailyRateCents: f.dailyRateCents,
        capabilities: f.capabilities, illustration: f.illustration,
        ownerCompanyId: ownerId, isPublished: f.isPublished,
      },
    });
  }

  const counts = {
    blogPosts: await prisma.blogPost.count(),
    wikiArticles: await prisma.wikiArticle.count(),
    caseStudies: await prisma.caseStudy.count(),
    facilities: await prisma.labFacility.count(),
  };
  console.log('✅ Done.', counts);
}

main()
  .catch((e) => {
    console.error('Content seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
