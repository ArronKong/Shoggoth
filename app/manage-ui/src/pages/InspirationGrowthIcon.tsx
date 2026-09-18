import { useEffect, useState } from 'react';
import styles from './InspirationGrowthIcon.module.css';

// One spine persists through every stage. The two outer contours become roots,
// then leaves, then the apple's two halves. Matching cubic segments let CSS
// interpolate the actual paths without replacing glyphs or running a JS loop.
export default function InspirationGrowthIcon({ enabled }: { enabled: boolean }) {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    if (!enabled) return;
    const updateVisibility = () => setVisible(!document.hidden);
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, [enabled]);

  return <svg className={styles.icon} data-growing={enabled} data-paused={!visible}
    width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path className={styles.spine} data-growth-part="spine" d="M9.35843 5.51842C8.15364 6.1482 7.14052 7.27084 6.56551 8.58515C6.2917 9.18755 6.15479 9.73518 6.12741 10.2554" />
    <path className={styles.contourLeft} data-growth-part="contour-left" pathLength="1" d="M11.2206 2.78038C10.2075 2.23274 8.81105 2.69823 7.33245 3.46491C5.97706 4.17683 4.8202 5.20364 3.97821 6.37077C3.13623 7.53791 2.60914 8.84537 2.5133 10.1186C2.34901 12.3365 3.71809 13.733 5.99075 13.8425" />
    <path className={styles.contourRight} data-growth-part="contour-right" pathLength="1" d="M11.2206 2.78038C12.2474 3.32801 12.94562 4.19737 13.27763 5.22418C13.60963 6.25099 13.5754 7.43524 13.1373 8.61264C12.5623 10.17337 11.52866 11.51506 10.26226 12.44946C8.99587 13.38385 7.49674 13.91095 5.99075 13.8425" />
    <g className={styles.roots} data-growth-stage="roots">
      <path className={styles.rootStem} data-growth-part="root-stem" pathLength="1" d="M8.16912 6.72049C8.16912 6.72049 7.50892 4.06443 7.5 3C7.48969 1.76949 8.16912 .853516 8.16912 .853516" />
      <path className={styles.rootTipRight} data-growth-part="root-tip-right" pathLength="1" d="M12.6655 9.60889C12.6655 10.6125 12.8877 11.6084 13.1099 12.3898" />
      <path className={styles.rootTipLeft} data-growth-part="root-tip-left" pathLength="1" d="M7.84715 9.60889C6.62141 10.4975 5.50292 11.8305 4.83643 13.3857" />
      <path className={styles.rootForkRight} data-growth-part="root-fork-right" pathLength="1" d="M8.61279 11.8306C9.72362 12.3898 10.2829 13.2785 10.505 14.1671" />
      <path className={styles.rootForkDown} data-growth-part="root-fork-down" pathLength="1" d="M8.61311 11.8306C8.28369 13.0563 8.28369 14.282 8.28369 15.5001" />
    </g>
    <g className={styles.veins} data-growth-stage="sprout">
      <path className={styles.veinLeft} data-growth-part="vein-left" pathLength="1" d="M8.43802 9.76506L4.93927 6.26631" />
      <path className={styles.veinRight} data-growth-part="vein-right" pathLength="1" d="M8.43802 6.966L11.9368 4.16701" />
    </g>
    <path className={styles.fruitLeaf} data-growth-part="fruit-leaf" pathLength="1" d="M7.82736 4.01812C7.75736 2.21306 6.81833 1.19493 5.00055 1.41607C5.07055 3.22114 6.11262 4.08462 7.82736 4.01812Z" />
  </svg>;
}
