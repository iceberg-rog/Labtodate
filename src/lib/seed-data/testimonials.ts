export interface TestimonialItem {
  quote: string;
  author: string;
  role: string;
  company: string;
  rating: number;
}

export const TESTIMONIALS: TestimonialItem[] = [
  {
    quote:
      'We saved 42% on a Zeiss confocal versus quotes from our usual distributors — and the inspection report was more detailed than what the OEM provides.',
    author: 'Dr. Anna Vermeer',
    role: 'Head of Imaging Core',
    company: 'Pivot Park',
    rating: 5,
  },
  {
    quote:
      'The "Let Us Find It" team sourced a discontinued mass spec component in 11 days. Saved us a six-month rebuild.',
    author: 'Prof. Daniel Okafor',
    role: 'Principal Investigator',
    company: 'Northeastern University',
    rating: 5,
  },
  {
    quote:
      'Listing my surplus inventory took 20 minutes. First serious enquiry came in two days. This is how lab gear should be sold.',
    author: 'Marie Lefèvre',
    role: 'Lab Operations Manager',
    company: 'EPOCH BioDesign',
    rating: 5,
  },
];
