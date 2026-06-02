/**
 * Seed lab2date own-inventory catalogue — ~100 curated products with no
 * shop affiliation (companyId = null). Run once; idempotent (upserts on slug).
 *
 *   npx tsx prisma/seed-own-catalogue.ts
 *
 * The seller is a synthetic ADMIN user (seed_user_admin_curator). The
 * products are real instrument models priced realistically. Status =
 * PUBLISHED so they show up on the marketplace immediately.
 *
 * To preview before publishing, set PREVIEW=1 — items go to DRAFT instead.
 */

import { PrismaClient, ProductCondition, ProductMode, ProductStatus } from '@prisma/client';

const prisma = new PrismaClient();

const SELLER_ID = 'seed_user_admin_curator';
const SELLER_EMAIL = 'curator@lab2date.com';

interface Seed {
  title: string;
  summary: string;
  brand: string;
  categorySlug: string;
  illustration: 'microscope' | 'centrifuge' | 'pcr' | 'hplc' | 'massspec' | 'balance' | 'gc' | 'autosampler' | 'detector';
  condition: ProductCondition;
  mode: ProductMode;
  priceEur: number | null;
  yearMade: number | null;
  quantity: number;
  specs?: Record<string, string>;
}

const SEEDS: Seed[] = [
  // HPLC / LC
  { title: 'Agilent 1100 Series HPLC — Quaternary pump + DAD + autosampler', summary: 'Refurbished bench-top HPLC stack; fully tested, includes column compartment.', brand: 'Agilent', categorySlug: 'hplc-lc', illustration: 'hplc', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 9800, yearMade: 2005, quantity: 1, specs: { 'Detector': 'DAD G1315B', 'Pump': 'Quat G1311A', 'Autosampler': 'G1313A' } },
  { title: 'Agilent 1200 Series HPLC — Binary pump + VWD + ALS', summary: 'Workhorse binary HPLC system; ChemStation-ready, low operating hours.', brand: 'Agilent', categorySlug: 'hplc-lc', illustration: 'hplc', condition: 'REFURBISHED', mode: 'HYBRID', priceEur: 12500, yearMade: 2010, quantity: 1 },
  { title: 'Agilent 1260 Infinity HPLC — Bio-inert Quaternary + DAD', summary: 'Bio-inert flow path; ready for protein and biopharma workflows.', brand: 'Agilent', categorySlug: 'hplc-lc', illustration: 'hplc', condition: 'REFURBISHED', mode: 'HYBRID', priceEur: 18900, yearMade: 2014, quantity: 1 },
  { title: 'Waters Alliance 2695 HPLC + Waters 2487 UV detector', summary: 'Iconic Alliance separations module + dual-wavelength UV.', brand: 'Waters', categorySlug: 'hplc-lc', illustration: 'hplc', condition: 'USED', mode: 'BUY_NOW', priceEur: 7900, yearMade: 2008, quantity: 1 },
  { title: 'Waters Acquity UPLC H-Class — Quaternary solvent manager', summary: 'High-throughput UPLC backbone; PEEK-free flow path.', brand: 'Waters', categorySlug: 'hplc-lc', illustration: 'hplc', condition: 'REFURBISHED', mode: 'HYBRID', priceEur: 28000, yearMade: 2016, quantity: 1 },
  { title: 'Shimadzu Nexera X2 UHPLC — LC-30AD pumps + SIL-30AC + SPD-M30A', summary: 'Top-tier UHPLC system; up to 130 MPa pressure capability.', brand: 'Shimadzu', categorySlug: 'hplc-lc', illustration: 'hplc', condition: 'REFURBISHED', mode: 'QUOTE_ONLY', priceEur: null, yearMade: 2017, quantity: 1 },
  { title: 'Shimadzu Prominence LC-20AT — Quaternary HPLC', summary: 'Reliable quaternary HPLC pump; widely-supported workhorse.', brand: 'Shimadzu', categorySlug: 'hplc-lc', illustration: 'pumps-fluidics' as never, condition: 'USED', mode: 'BUY_NOW', priceEur: 4500, yearMade: 2012, quantity: 2 },
  { title: 'Thermo Vanquish Horizon UHPLC — Binary pump + DAD', summary: 'Modern Vanquish stack; charge-detected variants available on quote.', brand: 'Thermo', categorySlug: 'hplc-lc', illustration: 'hplc', condition: 'REFURBISHED', mode: 'HYBRID', priceEur: 36000, yearMade: 2019, quantity: 1 },
  { title: 'Thermo Dionex UltiMate 3000 RS — Binary pump + DAD', summary: 'RS-grade UltiMate; rugged for routine method development.', brand: 'Dionex', categorySlug: 'hplc-lc', illustration: 'hplc', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 16500, yearMade: 2015, quantity: 1 },
  { title: 'Hitachi Chromaster HPLC — 5430 DAD + 5160 pump', summary: 'Hitachi mid-range HPLC system; LCD touchscreens and Ethernet ready.', brand: 'Hitachi', categorySlug: 'hplc-lc', illustration: 'hplc', condition: 'USED', mode: 'BUY_NOW', priceEur: 8500, yearMade: 2014, quantity: 1 },

  // GC
  { title: 'Agilent 7890A GC with FID + split/splitless inlet', summary: 'GC workhorse with FID; ready for routine separations.', brand: 'Agilent', categorySlug: 'gc', illustration: 'gc', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 12500, yearMade: 2011, quantity: 1 },
  { title: 'Agilent 7890B GC with dual FID + 7693 autosampler', summary: 'Dual-detector configuration with autosampler; tested and aligned.', brand: 'Agilent', categorySlug: 'gc', illustration: 'gc', condition: 'REFURBISHED', mode: 'HYBRID', priceEur: 18500, yearMade: 2014, quantity: 1 },
  { title: 'Agilent 6890N GC — FID + ECD configuration', summary: 'Dual-channel ECD/FID; ideal for environmental analytics.', brand: 'Agilent', categorySlug: 'gc', illustration: 'gc', condition: 'USED', mode: 'BUY_NOW', priceEur: 6900, yearMade: 2007, quantity: 2 },
  { title: 'Shimadzu GC-2010 Plus — FID + AOC-20i autosampler', summary: 'Capillary GC with FID and 12-position autosampler.', brand: 'Shimadzu', categorySlug: 'gc', illustration: 'gc', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 10800, yearMade: 2013, quantity: 1 },
  { title: 'Thermo Trace 1310 GC — FID + Triplus 100 LS autosampler', summary: 'Thermo Trace GC; touchscreen and modular inlets.', brand: 'Thermo', categorySlug: 'gc', illustration: 'gc', condition: 'REFURBISHED', mode: 'HYBRID', priceEur: 14500, yearMade: 2016, quantity: 1 },
  { title: 'PerkinElmer Clarus 580 GC — FID', summary: 'Compact Clarus 580 GC; flame ionisation detector.', brand: 'PerkinElmer', categorySlug: 'gc', illustration: 'gc', condition: 'USED', mode: 'BUY_NOW', priceEur: 6500, yearMade: 2012, quantity: 1 },

  // Mass Spec
  { title: 'Agilent 6470 Triple Quadrupole LC/MS', summary: 'Sensitive triple-quad for quantitative LC-MS work.', brand: 'Agilent', categorySlug: 'mass-spec', illustration: 'massspec', condition: 'REFURBISHED', mode: 'QUOTE_ONLY', priceEur: null, yearMade: 2018, quantity: 1 },
  { title: 'Agilent 5977B GC/MSD (single quad)', summary: 'Robust single-quad GC/MSD for trace organic analysis.', brand: 'Agilent', categorySlug: 'mass-spec', illustration: 'massspec', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 24500, yearMade: 2017, quantity: 1 },
  { title: 'Waters Xevo TQ-S micro Triple Quadrupole', summary: 'High-sensitivity benchtop tandem MS; UPLC compatible.', brand: 'Waters', categorySlug: 'mass-spec', illustration: 'massspec', condition: 'REFURBISHED', mode: 'QUOTE_ONLY', priceEur: null, yearMade: 2018, quantity: 1 },
  { title: 'Thermo Q Exactive Plus Orbitrap MS', summary: 'High-res Orbitrap with quadrupole prefilter; proteomics-grade.', brand: 'Thermo', categorySlug: 'mass-spec', illustration: 'massspec', condition: 'REFURBISHED', mode: 'QUOTE_ONLY', priceEur: null, yearMade: 2017, quantity: 1 },
  { title: 'Sciex QTRAP 6500 LC/MS/MS', summary: 'Triple-quad linear ion trap; quantitative and qualitative workflows.', brand: 'Sciex', categorySlug: 'mass-spec', illustration: 'massspec', condition: 'REFURBISHED', mode: 'QUOTE_ONLY', priceEur: null, yearMade: 2016, quantity: 1 },
  { title: 'Bruker amaZon SL Ion Trap MS', summary: 'Ion-trap MS with ESI source; ideal for screening workflows.', brand: 'Bruker', categorySlug: 'mass-spec', illustration: 'massspec', condition: 'USED', mode: 'QUOTE_ONLY', priceEur: null, yearMade: 2014, quantity: 1 },

  // Spectroscopy
  { title: 'Agilent Cary 60 UV-Vis Spectrophotometer', summary: 'Compact UV-Vis with xenon flash lamp; fibre-optic ready.', brand: 'Agilent', categorySlug: 'spectroscopy', illustration: 'detector', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 4500, yearMade: 2018, quantity: 3 },
  { title: 'Agilent Cary 5000 UV-Vis-NIR Spectrophotometer', summary: 'Research-grade UV-Vis-NIR; 175–3300 nm range.', brand: 'Agilent', categorySlug: 'spectroscopy', illustration: 'detector', condition: 'REFURBISHED', mode: 'HYBRID', priceEur: 22500, yearMade: 2015, quantity: 1 },
  { title: 'Shimadzu UV-1800 UV-Vis Spectrophotometer', summary: 'Reliable double-beam UV-Vis; widely used in QC.', brand: 'Shimadzu', categorySlug: 'spectroscopy', illustration: 'detector', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 3200, yearMade: 2017, quantity: 4 },
  { title: 'Thermo Nicolet iS50 FTIR Spectrometer', summary: 'Top-class FTIR with automated beamsplitter; ATR available.', brand: 'Thermo', categorySlug: 'spectroscopy', illustration: 'detector', condition: 'REFURBISHED', mode: 'HYBRID', priceEur: 18500, yearMade: 2016, quantity: 1 },
  { title: 'PerkinElmer Spectrum Two FTIR', summary: 'Compact FTIR; integrated ATR option; great for materials labs.', brand: 'PerkinElmer', categorySlug: 'spectroscopy', illustration: 'detector', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 8900, yearMade: 2018, quantity: 2 },
  { title: 'Bruker Tensor 27 FTIR Spectrometer', summary: 'Versatile FTIR; mid-IR coverage; widely supported in academia.', brand: 'Bruker', categorySlug: 'spectroscopy', illustration: 'detector', condition: 'USED', mode: 'BUY_NOW', priceEur: 6500, yearMade: 2010, quantity: 1 },
  { title: 'Agilent 5100 ICP-OES', summary: 'Dual-view ICP-OES; vertical torch; fast routine elemental analysis.', brand: 'Agilent', categorySlug: 'spectroscopy', illustration: 'massspec', condition: 'REFURBISHED', mode: 'QUOTE_ONLY', priceEur: null, yearMade: 2016, quantity: 1 },
  { title: 'PerkinElmer PinAAcle 900T Atomic Absorption', summary: 'Flame + furnace AAS; combined techniques in one platform.', brand: 'PerkinElmer', categorySlug: 'spectroscopy', illustration: 'detector', condition: 'REFURBISHED', mode: 'HYBRID', priceEur: 14500, yearMade: 2015, quantity: 1 },

  // Microscopy
  { title: 'Leica DM2500 LED Upright Microscope', summary: 'Research-grade upright microscope with LED illumination.', brand: 'Leica', categorySlug: 'microscopy', illustration: 'microscope', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 6500, yearMade: 2017, quantity: 2 },
  { title: 'Zeiss Axio Imager M2 — DIC + Fluorescence', summary: 'High-end research microscope with motorised XY stage.', brand: 'Zeiss', categorySlug: 'microscopy', illustration: 'microscope', condition: 'REFURBISHED', mode: 'HYBRID', priceEur: 18500, yearMade: 2014, quantity: 1 },
  { title: 'Olympus BX53 Upright Microscope — Fluorescence', summary: 'Fluorescence-ready upright with 5-position turret.', brand: 'Olympus', categorySlug: 'microscopy', illustration: 'microscope', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 9500, yearMade: 2016, quantity: 1 },
  { title: 'Nikon Eclipse Ti2 Inverted Microscope', summary: 'Inverted research microscope; motorised; live-cell ready.', brand: 'Nikon', categorySlug: 'microscopy', illustration: 'microscope', condition: 'REFURBISHED', mode: 'QUOTE_ONLY', priceEur: null, yearMade: 2019, quantity: 1 },
  { title: 'Leica TCS SP8 Confocal Laser Scanning Microscope', summary: 'Premium confocal; spectral detection; available on quote.', brand: 'Leica', categorySlug: 'microscopy', illustration: 'microscope', condition: 'USED', mode: 'QUOTE_ONLY', priceEur: null, yearMade: 2013, quantity: 1 },
  { title: 'Olympus CX23 LED Teaching Microscope', summary: 'Compact teaching microscope; LED illumination; bulk-friendly.', brand: 'Olympus', categorySlug: 'microscopy', illustration: 'microscope', condition: 'NEW', mode: 'BUY_NOW', priceEur: 850, yearMade: 2024, quantity: 12 },

  // Centrifuges
  { title: 'Beckman Allegra X-30R Refrigerated Centrifuge', summary: 'High-capacity refrigerated benchtop; broad rotor selection.', brand: 'Beckman', categorySlug: 'centrifuges', illustration: 'centrifuge', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 9800, yearMade: 2018, quantity: 1 },
  { title: 'Beckman Avanti J-26S XPI Floor Centrifuge', summary: 'High-performance floor centrifuge with refrigeration.', brand: 'Beckman', categorySlug: 'centrifuges', illustration: 'centrifuge', condition: 'USED', mode: 'HYBRID', priceEur: 19500, yearMade: 2012, quantity: 1 },
  { title: 'Eppendorf 5810R Refrigerated Centrifuge', summary: 'Versatile refrigerated benchtop; covers tubes, plates, microplates.', brand: 'Eppendorf', categorySlug: 'centrifuges', illustration: 'centrifuge', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 5800, yearMade: 2017, quantity: 3 },
  { title: 'Eppendorf 5424 Microcentrifuge', summary: '24-position microcentrifuge; 21,300 × g max.', brand: 'Eppendorf', categorySlug: 'centrifuges', illustration: 'centrifuge', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 1850, yearMade: 2019, quantity: 6 },
  { title: 'Thermo Sorvall Legend XTR Refrigerated', summary: 'Bench-top refrigerated; flexible rotor options.', brand: 'Thermo', categorySlug: 'centrifuges', illustration: 'centrifuge', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 7900, yearMade: 2016, quantity: 1 },
  { title: 'Thermo Sorvall LYNX 6000 Floor Centrifuge', summary: 'High-throughput floor centrifuge for process labs.', brand: 'Thermo', categorySlug: 'centrifuges', illustration: 'centrifuge', condition: 'USED', mode: 'QUOTE_ONLY', priceEur: null, yearMade: 2014, quantity: 1 },

  // Autosamplers, pumps, detectors, vacuum/gas
  { title: 'Agilent 7693A Autosampler for GC', summary: '150-vial GC autosampler; widely compatible.', brand: 'Agilent', categorySlug: 'autosamplers', illustration: 'autosampler', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 4800, yearMade: 2015, quantity: 2 },
  { title: 'Waters 2767 Sample Manager', summary: 'High-capacity sample manager for prep LC systems.', brand: 'Waters', categorySlug: 'autosamplers', illustration: 'autosampler', condition: 'USED', mode: 'BUY_NOW', priceEur: 3900, yearMade: 2010, quantity: 1 },
  { title: 'Thermo TriPlus 100 Liquid Autosampler', summary: 'GC liquid autosampler; up to 100 positions.', brand: 'Thermo', categorySlug: 'autosamplers', illustration: 'autosampler', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 4500, yearMade: 2017, quantity: 1 },
  { title: 'Agilent G4225A Degasser', summary: '4-channel vacuum degasser for Agilent 1100/1200 systems.', brand: 'Agilent', categorySlug: 'pumps-fluidics', illustration: 'pcr', condition: 'USED', mode: 'BUY_NOW', priceEur: 950, yearMade: 2010, quantity: 4 },
  { title: 'Shimadzu LC-20AD Solvent Delivery Pump', summary: 'Reliable binary HPLC pump head; spares included.', brand: 'Shimadzu', categorySlug: 'pumps-fluidics', illustration: 'pcr', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 2100, yearMade: 2014, quantity: 3 },
  { title: 'Agilent G1314B Variable Wavelength Detector', summary: 'VWD with deuterium lamp; 190-600 nm.', brand: 'Agilent', categorySlug: 'detectors', illustration: 'detector', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 2400, yearMade: 2012, quantity: 3 },
  { title: 'Agilent G1315D Diode Array Detector', summary: 'DAD with full spectral capture; 190-950 nm.', brand: 'Agilent', categorySlug: 'detectors', illustration: 'detector', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 4200, yearMade: 2014, quantity: 2 },
  { title: 'Waters 2487 Dual λ Absorbance Detector', summary: 'Dual-wavelength UV; 190-700 nm range.', brand: 'Waters', categorySlug: 'detectors', illustration: 'detector', condition: 'USED', mode: 'BUY_NOW', priceEur: 2100, yearMade: 2010, quantity: 2 },
  { title: 'Edwards RV12 Rotary Vane Vacuum Pump', summary: 'Reliable backing pump for mass-spec and freeze-dryers.', brand: 'Other', categorySlug: 'vacuum-gas', illustration: 'pcr', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 1850, yearMade: 2019, quantity: 4 },
  { title: 'Pfeiffer HiCube 80 Eco Turbo Pump Station', summary: 'Turbo pump station; ideal for surface science and electron-beam apps.', brand: 'Other', categorySlug: 'vacuum-gas', illustration: 'pcr', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 4900, yearMade: 2017, quantity: 1 },
  { title: 'Parker Balston Nitrogen Generator NG-1L', summary: 'On-demand N2 generator; pure enough for ELSD/MS use.', brand: 'Other', categorySlug: 'vacuum-gas', illustration: 'pcr', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 6500, yearMade: 2018, quantity: 1 },

  // General Lab + Balance + Misc
  { title: 'Mettler Toledo XPE205 Analytical Balance', summary: 'Premium analytical balance; 220 g × 0.01 mg.', brand: 'Mettler', categorySlug: 'general-lab', illustration: 'balance', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 4500, yearMade: 2018, quantity: 2 },
  { title: 'Sartorius Quintix 224-1S Analytical Balance', summary: '220 g × 0.1 mg; touchscreen; ISO calibration certificate.', brand: 'Sartorius', categorySlug: 'general-lab', illustration: 'balance', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 2200, yearMade: 2019, quantity: 3 },
  { title: 'Eppendorf Mastercycler X50s PCR Thermocycler', summary: '96-well thermocycler with 4 individually-controllable blocks.', brand: 'Eppendorf', categorySlug: 'general-lab', illustration: 'pcr', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 5500, yearMade: 2019, quantity: 2 },
  { title: 'Bio-Rad CFX96 Real-Time PCR System', summary: '96-well qPCR; up to 5 fluorescence channels.', brand: 'Bio-Rad', categorySlug: 'general-lab', illustration: 'pcr', condition: 'REFURBISHED', mode: 'HYBRID', priceEur: 14500, yearMade: 2017, quantity: 1 },
  { title: 'Thermo Heratherm OMH60 Mechanical Convection Oven', summary: '60 L mechanical convection oven; up to 250 °C.', brand: 'Thermo', categorySlug: 'general-lab', illustration: 'balance', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 2400, yearMade: 2018, quantity: 1 },
  { title: 'Eppendorf ThermoMixer C with SmartBlock 2.0 mL', summary: 'Heated mixer for microtubes; precise temperature control.', brand: 'Eppendorf', categorySlug: 'general-lab', illustration: 'pcr', condition: 'NEW', mode: 'BUY_NOW', priceEur: 2100, yearMade: 2024, quantity: 4 },
  { title: 'Tecan Infinite 200 PRO Microplate Reader', summary: 'Modular plate reader; absorbance + fluorescence + luminescence.', brand: 'Tecan', categorySlug: 'general-lab', illustration: 'detector', condition: 'REFURBISHED', mode: 'HYBRID', priceEur: 12500, yearMade: 2016, quantity: 1 },
  { title: 'Thermo Multiskan SkyHigh Microplate Spectrophotometer', summary: '200-1000 nm; touchscreen; SkanIt software included.', brand: 'Thermo', categorySlug: 'general-lab', illustration: 'detector', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 5500, yearMade: 2019, quantity: 2 },
  { title: 'BINDER KB 53 Cooling Incubator', summary: 'Compressor-cooled incubator; -10 °C to +100 °C.', brand: 'Other', categorySlug: 'general-lab', illustration: 'balance', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 3200, yearMade: 2019, quantity: 1 },
  { title: 'IKA RV 10 Digital Rotary Evaporator', summary: 'Compact rotary evaporator; digital speed display.', brand: 'Other', categorySlug: 'general-lab', illustration: 'pcr', condition: 'NEW', mode: 'BUY_NOW', priceEur: 1850, yearMade: 2024, quantity: 3 },

  // Parts & consumables (smaller items, higher volume)
  { title: 'Agilent ZORBAX Eclipse Plus C18 column 4.6 × 150 mm 5 µm', summary: 'Versatile C18 HPLC column; pH 2-9, USP L1.', brand: 'Agilent', categorySlug: 'parts-modules', illustration: 'detector', condition: 'NEW', mode: 'BUY_NOW', priceEur: 420, yearMade: 2024, quantity: 20 },
  { title: 'Waters XBridge BEH C18 column 2.1 × 100 mm 1.7 µm', summary: 'Sub-2 µm BEH C18 column for UPLC; pH 1-12 stability.', brand: 'Waters', categorySlug: 'parts-modules', illustration: 'detector', condition: 'NEW', mode: 'BUY_NOW', priceEur: 580, yearMade: 2024, quantity: 14 },
  { title: 'Phenomenex Kinetex Biphenyl 4.6 × 100 mm 2.6 µm', summary: 'Core-shell biphenyl column; alternative selectivity for halogenated analytes.', brand: 'Other', categorySlug: 'parts-modules', illustration: 'detector', condition: 'NEW', mode: 'BUY_NOW', priceEur: 480, yearMade: 2024, quantity: 12 },
  { title: 'Agilent Deuterium Lamp G1314-60100 (1100/1200 VWD)', summary: 'Replacement deuterium lamp; ~2000 h average lifetime.', brand: 'Agilent', categorySlug: 'parts-modules', illustration: 'detector', condition: 'NEW', mode: 'BUY_NOW', priceEur: 380, yearMade: 2024, quantity: 8 },
  { title: 'Agilent 5067-4683 Inlet Frit (1100/1200)', summary: 'Inlet frit kit; OEM Agilent quality.', brand: 'Agilent', categorySlug: 'parts-modules', illustration: 'pcr', condition: 'NEW', mode: 'BUY_NOW', priceEur: 38, yearMade: 2024, quantity: 50 },
  { title: 'Waters PEEK 1/16" tubing 0.005" ID — 5 ft roll', summary: 'High-purity PEEK tubing; widely used in LC plumbing.', brand: 'Waters', categorySlug: 'parts-modules', illustration: 'pcr', condition: 'NEW', mode: 'BUY_NOW', priceEur: 32, yearMade: 2024, quantity: 60 },
  { title: 'Restek MXT-5 GC column 30 m × 0.25 mm × 0.25 µm', summary: 'General-purpose 5% phenyl methylsiloxane GC column.', brand: 'Other', categorySlug: 'parts-modules', illustration: 'detector', condition: 'NEW', mode: 'BUY_NOW', priceEur: 350, yearMade: 2024, quantity: 18 },
  { title: 'Vial kit 2 mL clear glass, 100 pcs + caps', summary: '12×32 mm autosampler vials; 9 mm screw caps with PTFE/silicone septa.', brand: 'Other', categorySlug: 'parts-modules', illustration: 'pcr', condition: 'NEW', mode: 'BUY_NOW', priceEur: 48, yearMade: 2024, quantity: 200 },
  { title: 'Hamilton 1705N 50 µL gas-tight syringe', summary: 'Removable-needle syringe for GC; PTFE-tipped plunger.', brand: 'Other', categorySlug: 'parts-modules', illustration: 'pcr', condition: 'NEW', mode: 'BUY_NOW', priceEur: 95, yearMade: 2024, quantity: 25 },
  { title: 'Sciex IonDrive Turbo V Source for QTRAP', summary: 'IonDrive Turbo V ESI/APCI source; field-serviced and tested.', brand: 'Sciex', categorySlug: 'parts-modules', illustration: 'massspec', condition: 'REFURBISHED', mode: 'BUY_NOW', priceEur: 8900, yearMade: 2017, quantity: 1 },
];

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
}

async function main() {
  const preview = process.env.PREVIEW === '1';
  console.log(`⇣ Seeding lab2date own-inventory (${SEEDS.length} products, status=${preview ? 'DRAFT' : 'PUBLISHED'})`);

  await prisma.user.upsert({
    where: { id: SELLER_ID },
    update: { email: SELLER_EMAIL, name: 'lab2date Curator', role: 'ADMIN' },
    create: { id: SELLER_ID, email: SELLER_EMAIL, name: 'lab2date Curator', role: 'ADMIN' },
  });

  const catBySlug = new Map<string, string>();
  for (const c of await prisma.category.findMany({ select: { slug: true, id: true } })) catBySlug.set(c.slug, c.id);
  const brandCache = new Map<string, string>();

  let n = 0;
  for (const s of SEEDS) {
    const categoryId = catBySlug.get(s.categorySlug);
    if (!categoryId) {
      console.warn(`  ! missing category ${s.categorySlug} — skipping ${s.title}`);
      continue;
    }
    let brandId: string | null = null;
    if (s.brand) {
      const bslug = slugify(s.brand);
      if (!brandCache.has(bslug)) {
        const b = await prisma.brand.upsert({
          where: { slug: bslug },
          update: { name: s.brand },
          create: { slug: bslug, name: s.brand },
        });
        brandCache.set(bslug, b.id);
      }
      brandId = brandCache.get(bslug)!;
    }
    const slug = slugify(`own-${s.title}`).slice(0, 80);
    const data = {
      title: s.title,
      summary: s.summary,
      description: s.summary,
      condition: s.condition,
      mode: s.mode,
      status: preview ? ProductStatus.DRAFT : ProductStatus.PUBLISHED,
      priceCents: s.priceEur === null ? null : Math.round(s.priceEur * 100),
      currency: 'EUR',
      quantity: s.quantity,
      yearMade: s.yearMade,
      illustration: s.illustration,
      images: [] as string[],
      hasImages: false,
      categoryId,
      brandId,
      sellerId: SELLER_ID,
      companyId: null,
      specs: s.specs ?? undefined,
    };
    await prisma.product.upsert({
      where: { slug },
      update: data,
      create: { slug, ...data },
    });
    n++;
  }
  console.log(`✓ Upserted ${n} curated own-inventory products.`);
  console.log(`Run again with PREVIEW=1 to seed as DRAFT instead of PUBLISHED.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
