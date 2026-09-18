import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openPath } from '../api/client';
import type { InspirationExecution } from '../types';
import { useToast } from '../components/ui';
import TurnProcess from '../components/TurnTimeline/TurnProcess';
import { IconTrajectory } from '../components/TurnTimeline/trajectoryIcons';
import { stepsFromParts } from '../lib/turnTimeline';
import { useInspirationActivity } from './use-inspiration-activity';
import styles from './InspirationPage.module.css';

export default function InspirationActivity({ ideaId, execution }: { ideaId: string; execution: InspirationExecution }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { activity, error, live, retry } = useInspirationActivity(ideaId, execution);
  const [opening, setOpening] = useState<string | null>(null);
  const steps = useMemo(() => stepsFromParts(activity?.trajectory.parts || [], { live, includeText: true }), [activity, live]);
  const open = async (file: string) => {
    if (opening) return;
    setOpening(file);
    try { await openPath(file); }
    catch (error) { toast.error(error instanceof Error ? error.message : t('inspiration.artifactOpenFailed')); }
    finally { setOpening(null); }
  };
  return <div className={styles.activity} data-inspiration-run={execution.runId}>
    <section aria-label={t('turnLab.processLabel')}>
      {steps.length ? <TurnProcess steps={steps} live={live} defaultOpen /> : <div className={styles.trajectoryEmpty}>
        <span className={styles.trajectoryLabel}><IconTrajectory />{t('turnLab.processLabel')}</span>
        <p className={styles.meta} role="status">{t(error ? 'inspiration.activityUnavailable'
          : !activity ? 'common.loading' : live && (!activity.trajectory.reason || activity.trajectory.reason === 'preparing')
            ? 'inspiration.trajectoryWaiting' : activity.trajectory.reason ? 'inspiration.trajectoryUnavailable' : 'inspiration.trajectoryEmpty')}</p>
      </div>}
      {activity?.trajectory.truncated && <p className={styles.meta}>{t('inspiration.trajectoryTruncated')}</p>}
      {error && steps.length > 0 && <p className={styles.meta} role="status">{t('inspiration.activityUnavailable')}</p>}
      {error && <button className={styles.textAction} onClick={retry}>{t('common.retry')}</button>}
    </section>
    {Boolean(activity?.artifacts.items.length) && <section aria-label={t('inspiration.artifacts')} className={styles.artifacts}>
      <div className={styles.sectionHeading}><h3>{t('inspiration.artifacts')}</h3>
        <span className={styles.meta}>{t('inspiration.artifactOpenHint')}</span></div>
      <ul className={styles.artifactList}>{activity!.artifacts.items.map(file => <li key={file.path}>
        <button className={styles.artifactButton} disabled={opening !== null} onClick={() => { void open(file.path); }}
          title={file.path} aria-label={t('inspiration.openArtifact', { name: file.name })}>
          <span className={styles.artifactType} aria-hidden="true">{(file.ext?.slice(1) || 'FILE').slice(0, 5).toUpperCase()}</span>
          <span className={styles.artifactName}><strong>{file.name}</strong><span>{file.path}</span></span>
          <span className={styles.artifactOpen} aria-hidden="true">↗</span>
        </button>
      </li>)}</ul>
      {activity?.artifacts.hasMore && <p className={styles.meta}>{t('inspiration.artifactsMore')}</p>}
    </section>}
    {activity?.artifacts.reason === 'remote' && <p className={styles.meta}>{t('inspiration.artifactsRemote')}</p>}
  </div>;
}
