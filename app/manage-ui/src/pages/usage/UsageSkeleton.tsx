import { SkeletonShape, SkeletonStatus } from "../../components/Skeleton";
import styles from "./UsageSkeleton.module.css";

const barHeights = [30, 48, 39, 65, 52, 79, 60, 49, 67, 55, 88, 70];

export function UsageChartSkeleton({ bars = false }: { bars?: boolean }) {
  return (
    <SkeletonStatus className="uc-box">
      <div className={styles.plot}>
        <div className={bars ? styles.bars : styles.lines}>
          {bars
            ? barHeights.map((height, index) => (
                <SkeletonShape className={styles.bar} style={{ height: `${height}%` }} key={index} />
              ))
            : [0, 1, 2].map((index) => <SkeletonShape className={styles.line} key={index} />)}
        </div>
      </div>
      <div className={styles.ticks}>
        {[0, 1, 2, 3].map((index) => <SkeletonShape style={{ width: "2em", height: 7 }} key={index} />)}
      </div>
    </SkeletonStatus>
  );
}

export function UsageRankSkeleton({ agent = false }: { agent?: boolean }) {
  const rows = (agent ? [46, 37, 52, 31] : [52, 39, 46]).map((width, index) => (
    <div key={index}>
      <div className={agent ? "arank-head" : "rank-head"}>
        {agent && <SkeletonShape style={{ width: 16, height: 16, borderRadius: "50%" }} />}
        <SkeletonShape style={{ width: `${width}%`, height: 9 }} />
        <SkeletonShape style={{ width: "24%", height: 9, marginLeft: "auto" }} />
      </div>
      <div className={agent ? "arank-bar" : "rank-bar"}>
        <SkeletonShape className={styles.rankBar} style={{ width: `${90 - index * 19}%` }} />
      </div>
    </div>
  ));
  return <SkeletonStatus className={agent ? "arank" : "rank"}>{rows}</SkeletonStatus>;
}
