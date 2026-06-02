export interface SupplierItem {
  slug: string;
  name: string;
  country: string;
  productsCount: number;
  yearsActive: number;
  description: string;
  verified: boolean;
}

export const FEATURED_SUPPLIERS: SupplierItem[] = [
  {
    slug: 'biolab-refurb-gmbh',
    name: 'BioLab Refurb GmbH',
    country: 'Germany',
    productsCount: 412,
    yearsActive: 12,
    description: 'Certified refurbished centrifuges, balances and bioreactors.',
    verified: true,
  },
  {
    slug: 'northeast-scientific',
    name: 'Northeast Scientific',
    country: 'USA',
    productsCount: 286,
    yearsActive: 18,
    description: 'Premium chromatography and mass spectrometry systems.',
    verified: true,
  },
  {
    slug: 'optiscope-trade-bv',
    name: 'OptiScope Trade BV',
    country: 'Netherlands',
    productsCount: 173,
    yearsActive: 9,
    description: 'Microscopy specialists — Zeiss, Leica, Olympus, Nikon.',
    verified: true,
  },
  {
    slug: 'pivot-park-instruments',
    name: 'Pivot Park Instruments',
    country: 'Netherlands',
    productsCount: 91,
    yearsActive: 7,
    description: 'High-end analytical instruments for pharma R&D.',
    verified: true,
  },
  {
    slug: 'eurolab-supplies',
    name: 'EuroLab Supplies',
    country: 'Belgium',
    productsCount: 528,
    yearsActive: 15,
    description: 'New OEM equipment from Sartorius, Eppendorf, Mettler.',
    verified: true,
  },
  {
    slug: 'asia-scientific-direct',
    name: 'Asia Scientific Direct',
    country: 'Singapore',
    productsCount: 247,
    yearsActive: 6,
    description: 'Asia-Pacific sourcing for lab essentials.',
    verified: false,
  },
];
