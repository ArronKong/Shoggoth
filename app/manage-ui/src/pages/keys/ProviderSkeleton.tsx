import { SkeletonShape, SkeletonStatus } from "../../components/Skeleton";
import styles from "./KeysPanel.module.css";

export function OAuthRowsSkeleton({ singleColumn = false }: { singleColumn?: boolean }) {
  return (
    <div className={singleColumn ? styles.oauthList : styles.oauthGrid}>
      {[92, 70, 105, 82].map((width) => (
        <div className={styles.oauthRow} key={width}>
          <SkeletonShape style={{ width: 18, height: 18, borderRadius: "50%" }} />
          <span className={styles.oauthText}>
            <SkeletonShape style={{ width, height: 10 }} />
            <SkeletonShape style={{ width: width + 34, height: 8 }} />
          </span>
        </div>
      ))}
    </div>
  );
}

export function ProviderRowsSkeleton() {
  return (
    <div className={`${styles.cardBody} ${styles.cardBodyFlush}`}>
      {[82, 104].map((width) => (
        <div className={styles.group} key={width}>
          <div className={styles.groupName}>
            <SkeletonShape style={{ width: 18, height: 18, borderRadius: "50%" }} />
            <SkeletonShape style={{ width, height: 10 }} />
          </div>
          <div className={styles.groupFields}>
            <SkeletonShape style={{ height: 32, borderRadius: 8 }} />
            <SkeletonShape style={{ height: 32, borderRadius: 8 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// While capabilities are unknown, reserve space for the common settings layout.
export function ProviderPaneSkeleton() {
  return (
    <SkeletonStatus className={styles.panel}>
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <SkeletonShape style={{ width: "8em" }} />
          <SkeletonShape style={{ width: "12em", height: 8 }} />
        </div>
        <OAuthRowsSkeleton />
      </div>
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <SkeletonShape style={{ width: "6em" }} />
          <SkeletonShape style={{ width: "10em", height: 8 }} />
        </div>
        <ProviderRowsSkeleton />
      </div>
    </SkeletonStatus>
  );
}
