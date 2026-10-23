import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { revealPath } from '../api/client';
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
  const [revealing, setRevealing] = useState<string | null>(null);
  const steps = useMemo(() => stepsFromParts(activity?.trajectory.parts || [], { live, includeText: true }), [activity, live]);
  // A finished round leads with its result: its trajectory starts folded, and an empty one stays out of the way.
  const unrecorded = Boolean(activity && !live && !error && !steps.length && !activity.trajectory.reason);
  const reveal = async (file: string) => {
    if (revealing) return;
    setRevealing(file);
    try { await revealPath(file); }
    catch (error) { toast.error(t('chat.artifactsRevealFailed', { msg: error instanceof Error ? error.message : String(error) })); }
    finally { setRevealing(null); }
  };
  return <div className={styles.activity} data-inspiration-run={execution.runId}>
    {!unrecorded && <section aria-label={t('turnLab.processLabel')}>
      {steps.length ? <TurnProcess steps={steps} live={live} defaultOpen={live} /> : <div className={styles.trajectoryEmpty}>
        <span className={styles.trajectoryLabel}><IconTrajectory />{t('turnLab.processLabel')}</span>
        <p className={styles.meta} role="status">{t(error ? 'inspiration.activityUnavailable'
          : !activity ? 'common.loading' : live && (!activity.trajectory.reason || activity.trajectory.reason === 'preparing')
            ? 'inspiration.trajectoryWaiting' : activity.trajectory.reason ? 'inspiration.trajectoryUnavailable' : 'inspiration.trajectoryEmpty')}</p>
      </div>}
      {activity?.trajectory.truncated && <p className={styles.meta}>{t('inspiration.trajectoryTruncated')}</p>}
      {error && steps.length > 0 && <p className={styles.meta} role="status">{t('inspiration.activityUnavailable')}</p>}
      {error && <button className={styles.textAction} onClick={retry}>{t('common.retry')}</button>}
    </section>}
    {Boolean(activity?.artifacts.items.length) && <section aria-label={t('inspiration.artifacts')} className={styles.artifacts}>
      <div className={styles.sectionHeading}><h3>{t('inspiration.artifacts')}</h3>
        <span className={styles.meta}>{t('chat.artifactsRevealInFolder')}</span></div>
      <ul className={styles.artifactList}>{activity!.artifacts.items.map(file => <li key={file.path}>
        <button className={styles.artifactButton} disabled={revealing !== null} onClick={() => { void reveal(file.path); }}
          title={file.path} aria-label={t('inspiration.revealArtifact', { name: file.name })}>
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
