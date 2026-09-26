import type { InspirationIdea } from '../types';
import styles from './InspirationStatusIcon.module.css';

export function inspirationGrowthStage(status: InspirationIdea['status'], archived = false) {
  if (archived) return 3;
  if (status === 'completed') return 2;
  if (['starting', 'running', 'waiting_input', 'waiting_approval'].includes(status)) return 1;
  if (['saved', 'queued', 'skipped'].includes(status)) return 0;
  return -1;
}

const GLYPHS = ['seed', 'roots', 'sprout', 'fruit'] as const;

export default function InspirationStatusIcon({ status, archived = false, className }: {
  status: InspirationIdea['status']; archived?: boolean; className?: string;
}) {
  const stage = inspirationGrowthStage(status, archived);
  // Interrupted growth keeps the roots glyph; the status label and semantic color
  // identify the issue. Exact Figma assets also serve the four stage filters.
  const glyph = stage === -1 ? 'roots' : GLYPHS[stage];
  return <span className={[styles.icon, className].filter(Boolean).join(' ')} aria-hidden="true"
    data-growth={stage < 0 ? 'wilted' : glyph}>
    {GLYPHS.map(name => <span key={name} className={`${styles.glyph} ${styles[name]}`} data-visible={name === glyph} />)}
  </span>;
}
