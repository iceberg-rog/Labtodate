// X/Twitter reuses the OpenGraph card; the metadata in layout.tsx already
// declares summary_large_image.
export { default, alt, size, contentType } from './opengraph-image';
// Route segment config must be a literal in this file (same as opengraph-image).
export const revalidate = 3600;
