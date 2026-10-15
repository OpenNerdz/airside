// Inline SVG icons. The aircraft shape is Material Icons "flight" (Apache 2.0).
const PLANE = 'M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z';

const paths = {
  departure: `<path d="${PLANE}" fill="currentColor" transform="rotate(60 12 12)"/>`,
  arrival: `<path d="${PLANE}" fill="currentColor" transform="rotate(120 12 12)"/>`,
  cruise: `<path d="${PLANE}" fill="currentColor" transform="rotate(90 12 12)"/>`,
  search: '<circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="m15.5 15.5 5 5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  back: '<path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
};

export const icon = (name, cls = 'i') =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
