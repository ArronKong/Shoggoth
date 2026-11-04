import styles from './InspirationStatusIcon.module.css';

const toolbarPaths = {
  session: 'M3 12a7 7 0 0 1 7-7h4a7 7 0 0 1 0 14H3z',
  favorite: 'm12 3.3 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3L2.9 9.9l6.3-.9z',
  delete: 'M3.5 6.5h17M9 6.5v-2a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 6.5V18a2.5 2.5 0 0 0 2.5 2.5h7A2.5 2.5 0 0 0 18 18V6.5M10 10.5v6m4-6v6',
};

export default function InspirationActionIcon({ name, className, filled = false, toolbar = false }: {
  name: 'favorite' | 'archive' | 'edit' | 'arrow' | 'chevron' | 'check' | 'session' | 'delete';
  className?: string; filled?: boolean; toolbar?: boolean;
}) {
  // Keep the exported favorite glyph in the stage filter and on note cards.
  if (name === 'favorite' && !toolbar) return <span className={[styles.favorite, className].filter(Boolean).join(' ')}
    data-inspiration-icon="favorite" data-filled={filled || undefined} aria-hidden="true" />;
  if (name === 'session' || name === 'favorite' || name === 'delete') {
    return <svg className={className} data-inspiration-icon={name} viewBox="0 0 24 24" width="20" height="20"
      fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={toolbarPaths[name]} />
      {name === 'session' && <path d="M8 12h.01m4 0h.01m4 0h.01" strokeWidth="2" />}
    </svg>;
  }
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
