import styles from './InspirationStatusIcon.module.css';

// Favorites share the exported Figma glyph with the stage filter capsule.
export default function InspirationActionIcon({ name, className, filled = false }: {
  name: 'favorite' | 'archive' | 'edit' | 'arrow' | 'chevron' | 'check';
  className?: string; filled?: boolean;
}) {
  if (name === 'favorite') return <span className={[styles.favorite, className].filter(Boolean).join(' ')}
    data-inspiration-icon="favorite" data-filled={filled || undefined} aria-hidden="true" />;
  const paths = {
    archive: 'M7 13v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V13M5 7h22v6H5ZM12 18h8',
    edit: 'm20 6 6 6M7 20 21 6a2.1 2.1 0 0 1 3 0l2 2a2.1 2.1 0 0 1 0 3L12 25l-7 2ZM7 20l5 5',
    arrow: 'M6 16h20m-8-8 8 8-8 8',
    chevron: 'm10 13 6 6 6-6',
    check: 'm7 16 6 6L25 10',
  };
  return <svg className={className} viewBox="0 0 32 32" width="20" height="20"
    fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.55"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d={paths[name]} />
  </svg>;
}
