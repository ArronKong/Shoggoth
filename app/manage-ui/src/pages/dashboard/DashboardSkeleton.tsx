import { useTranslation } from "react-i18next";
import { SkeletonShape as Shape } from "../../components/Skeleton";
import styles from "./DashboardSkeleton.module.css";

// Dashboard owns its placeholder layout. These shapes use the same card/row CSS
// as the page, without mounting data-fetching components or retaining content.
export function DashboardKpiValueSkeleton() {
  return <Shape className={styles.value} />;
}

export function DashboardKpiSubSkeleton() {
  return <Shape className={styles.comparison} />;
}

export function DashboardActivitySkeleton() {
  const { t } = useTranslation();
  return (
    <div className={styles.rows} role="status" aria-label={t("common.loading")} data-dashboard-skeleton="activity">
      <div className="dash-feed" aria-hidden="true">
        {[72, 88, 62, 80, 68].map((width, index) => (
          <div className="dash-run" key={index}>
            <Shape className={`dash-run-agent-avatar ${styles.avatar}`} />
            <span className="dash-run-main">
              <span className={`dash-run-head ${styles.headline}`}>
                <Shape className={styles.agent} />
                <Shape style={{ width: `${width / 2}%` }} />
                <Shape className={`dash-run-meta ${styles.time}`} />
              </span>
              <span className="dash-run-summary"><Shape style={{ width: `${width}%` }} /></span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DashboardArtifactSkeleton() {
  return (
    <div className="dash-art-list" aria-hidden="true">
      {[78, 62, 86].map((width, index) => (
        <div className="dash-art" key={index}>
          <span className={styles.thumbnail}><Shape className={styles.fileIcon} /></span>
          <span className="dash-art-body">
            <span className="dash-art-name"><Shape style={{ width: `${width}%` }} /></span>
            <span className="dash-art-sub"><Shape style={{ width: "45%" }} /></span>
            <span className="dash-art-foot">
              <Shape style={{ width: "3em" }} />
              <Shape className={`dash-art-time ${styles.time}`} />
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

export function DashboardTaskBoardSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="kpi kpi-taskboard" aria-busy="true">
      <div className="tb-head">
        <span className="kpi-label">{t("dashboard.taskBoard")}</span>
        <span className="tb-badges"><Shape className={styles.badge} /><Shape className={styles.badge} /></span>
      </div>
      <div className="tb-cols" aria-hidden="true">
        {[0, 1].map(column => (
          <div className="tb-col" key={column}>
            {[0, 1, 2].map(row => (
              <div className="tb-row" key={row}>
                <Shape className={`tb-avatar ${styles.avatar}`} />
                <Shape className={styles.rankingName} style={{ width: `${64 - row * 10}%` }} />
                <Shape className={`tb-count ${styles.rankCount}`} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DashboardSkeleton({ backendCount }: { backendCount: number }) {
  const { t } = useTranslation();
  return (
    <div className={styles.page} role="status" aria-label={t("common.loading")}
      aria-busy="true" data-dashboard-skeleton="page">
      <div className="kpi-row" aria-hidden="true">
        {["dashboard.kpiTodayTokens", "dashboard.kpiTodayCost"].map((label, index) => (
          <div className={`kpi${index === 1 ? " kpi-cost" : ""}`} key={label}>
            <div className="kpi-label">{t(label)}</div>
            <div className="kpi-bottom">
              <div className="kpi-val"><DashboardKpiValueSkeleton /></div>
              <div className="kpi-sub"><DashboardKpiSubSkeleton /></div>
            </div>
          </div>
        ))}
        <DashboardTaskBoardSkeleton />
      </div>
      <div className="dash-columns" aria-hidden="true">
        <section className="dash-section">
          <div className="dash-feed-head">
            <h2 className="dash-section-title">{t("dashboard.feedTitle")}<Shape className={styles.sectionCount} /></h2>
            <div className="dash-feed-filters">
              <div className={`dash-kind-tabs ${styles.filters}`}>
                {["dashboard.filterAll", "dashboard.filterCron", "dashboard.filterInspiration"].map(label => (
                  <span className={styles.filterSlot} key={label}>
                    <span className={styles.filterText}>{t(label)}</span><Shape className={styles.filterBar} />
                  </span>
                ))}
              </div>
              {backendCount > 1 && (
                <div className={`dash-backend-tabs ${styles.filters}`}>
                  <span className={styles.filterSlot}>
                    <span className={styles.filterText}>{t("dashboard.filterAll")}</span><Shape className={styles.filterBar} />
                  </span>
                  {Array.from({ length: backendCount }, (_, index) => (
                    <span className={styles.filterIcon} key={index}><Shape className={styles.backendIcon} /></span>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="dash-activity-scroll"><DashboardActivitySkeleton /></div>
        </section>
        <section className="dash-section dash-artifacts">
          <h2 className="dash-section-title">{t("dashboard.artifactsTitle")}</h2>
          <DashboardArtifactSkeleton />
        </section>
      </div>
    </div>
  );
}
