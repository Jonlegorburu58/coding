/** Inline SVG icons (bundled, no icon font or CDN). Decorative unless `title` is given. */
const PATHS: Record<string, string> = {
  check: 'M3.5 8.5l3 3 6-7',
  cross: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  clock: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3.2l2 1.3',
  hourglass: 'M4.5 2.5h7M4.5 13.5h7M5 2.5c0 3 3 3.5 3 5.5s-3 2.5-3 5.5M11 2.5c0 3-3 3.5-3 5.5s3 2.5 3 5.5',
  pending: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM5.5 8h.01M8 8h.01M10.5 8h.01',
  dash: 'M4.5 8h7',
  question: 'M6 6.2a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9v.6M8 11.5h.01',
  grid: 'M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z',
  shield: 'M8 1.8l5 1.8v4c0 3-2.2 5.3-5 6.6-2.8-1.3-5-3.6-5-6.6v-4z',
  alert: 'M8 2l6 11H2zM8 6.5v3M8 11.5h.01',
  folder: 'M2 4.5h4l1.5 1.5H14v7H2z',
  calendar: 'M2.5 3.5h11v10h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3',
  sample: 'M3 3.5h10M3 8h10M3 12.5h6M12 11l1.5 1.5L16 10',
  settings: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  list: 'M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01',
  download: 'M8 2.5v8M4.5 7l3.5 3.5L11.5 7M2.5 13.5h11',
  print: 'M4.5 6V2.5h7V6M4.5 11.5h-2v-5h11v5h-2M4.5 9.5h7v4h-7z',
  table: 'M2.5 3.5h11v9h-11zM2.5 6.5h11M2.5 9.5h11M6.5 3.5v9',
  chart: 'M2.5 13.5h11M4 11l3-4 2.5 2.5L13 4.5',
  info: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 7.5v3.5M8 5.2h.01',
  refresh: 'M13 4v3h-3M3 12V9h3M12.3 7A4.5 4.5 0 0 0 4 5.5M3.7 9A4.5 4.5 0 0 0 12 10.5',
  search: 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.5 10.5l3 3',
  back: 'M10 3.5L5.5 8l4.5 4.5',
  lock: 'M4 7.5h8v6H4zM5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5',
  database: 'M3 4c0-1 2.2-1.8 5-1.8S13 3 13 4s-2.2 1.8-5 1.8S3 5 3 4zM3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8',
  user: 'M8 2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM3 13.5c.6-2.4 2.6-4 5-4s4.4 1.6 5 4',
};

export function Icon({ name, size = 16, title, className }: { name: keyof typeof PATHS | string; size?: number; title?: string; className?: string }) {
  const d = PATHS[name] ?? PATHS.info;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <path d={d} />
    </svg>
  );
}
