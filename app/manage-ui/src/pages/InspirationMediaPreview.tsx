import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { InspirationAttachment } from '../types';
import { formatInspirationMediaTime, groupInspirationMedia, inspirationMediaUrl, isInspirationDocument, middleEllipsis } from './inspiration-media';
import playIcon from '../assets/inspiration/media-play.svg';
import pauseIcon from '../assets/inspiration/media-pause.svg';
import waveform from '../assets/inspiration/media-waveform.svg';
import styles from './InspirationMedia.module.css';

function MediaFilename({ name, onOpen }: { name: string; onOpen?: () => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [display, setDisplay] = useState(name);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return;
    let alive = true;
    const update = () => {
      if (!alive) return;
      context.font = getComputedStyle(node).font;
      setDisplay(middleEllipsis(name, node.clientWidth, value => context.measureText(value).width));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    void document.fonts.ready.then(update);
    return () => { alive = false; observer.disconnect(); };
  }, [name]);
  const label = <span ref={ref} className={styles.filename} title={name} aria-label={name}><span aria-hidden="true">{display}</span></span>;
  return onOpen ? <button type="button" className={styles.filenameButton} onClick={onOpen}>{label}</button> : label;
}

function PlaybackIcon({ playing }: { playing: boolean }) {
  return <img className={styles.playbackIcon} src={playing ? pauseIcon : playIcon} alt="" aria-hidden="true" />;
}

function AudioAttachment({ item }: { item: InspirationAttachment }) {
  const { t } = useTranslation();
  const audio = useRef<HTMLAudioElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const graph = useRef<{ context: AudioContext; analyser: AnalyserNode }>();
  const durationProbe = useRef<{ abort: AbortController }>();
  const alive = useRef(true);
  const [playing, setPlaying] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  useEffect(() => {
    alive.current = true;
    const element = audio.current;
    return () => {
      alive.current = false; element?.pause(); void graph.current?.context.close();
      durationProbe.current?.abort.abort();
    };
  }, []);
  useEffect(() => {
    const analyser = graph.current?.analyser, surface = canvas.current;
    if (!playing || !analyser || !surface || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const context = surface.getContext('2d');
    if (!context) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    let frame = 0;
    const draw = () => {
      analyser.getByteFrequencyData(data);
      context.clearRect(0, 0, 320, 32);
      context.strokeStyle = getComputedStyle(surface).color;
      context.lineWidth = 2; context.lineCap = 'round';
      context.beginPath();
      for (let i = 0; i <= 20; i++) {
        const amplitude = data[Math.floor(i * (data.length - 1) / 20)] / 255;
        const height = 4 + amplitude * 24, x = 1 + i * 15.9;
        context.moveTo(x, 16 - height / 2); context.lineTo(x, 16 + height / 2);
      }
      context.stroke(); frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  const toggle = async () => {
    const element = audio.current;
    if (!element || pending) return;
    if (!element.paused) { element.pause(); return; }
    setPending(true); setFailed(false);
    try {
      if (!graph.current && window.AudioContext) {
        const context = new AudioContext(), analyser = context.createAnalyser();
        analyser.fftSize = 256; analyser.smoothingTimeConstant = .8;
        context.createMediaElementSource(element).connect(analyser); analyser.connect(context.destination);
        graph.current = { context, analyser };
      }
      void graph.current?.context.resume().catch(() => {});
      await element.play();
    } catch { if (alive.current) setFailed(true); }
    finally { if (alive.current) setPending(false); }
  };
  const updateDuration = () => {
    const value = audio.current?.duration;
    if (value && Number.isFinite(value)) setDuration(value);
    // MediaRecorder's streaming WebM may omit the duration header. Decode once
    // to recover its real length without seeking the visible player to infinity.
    else if (value === Infinity && !durationProbe.current && window.OfflineAudioContext) {
      // Metadata decoding must not open an output device (or its paired mic).
      const abort = new AbortController(), decoder = new OfflineAudioContext(1, 1, 48000);
      durationProbe.current = { abort };
      void fetch(inspirationMediaUrl(item.id), { signal: abort.signal }).then(response => {
        if (!response.ok) throw new Error('Audio unavailable');
        return response.arrayBuffer();
      }).then(data => decoder.decodeAudioData(data)).then(buffer => {
        if (alive.current && !abort.signal.aborted) setDuration(buffer.duration);
      }).catch(() => {});
    }
  };
  return <>
    <div className={styles.audio} data-playing={playing || undefined}>
      <audio ref={audio} preload="metadata" src={inspirationMediaUrl(item.id)} aria-label={item.name}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onDurationChange={updateDuration} onLoadedMetadata={updateDuration}
        onTimeUpdate={() => { setPosition(audio.current?.currentTime || 0); updateDuration(); }}
        onEnded={() => { setPlaying(false); setPosition(0); if (audio.current) audio.current.currentTime = 0; }}
        onError={() => { setFailed(true); setPlaying(false); setPending(false); }} />
      <button type="button" className={styles.playbackButton} disabled={pending} aria-busy={pending || undefined}
        aria-label={t(playing ? 'inspiration.media.pause' : 'inspiration.media.play', { name: item.name })} onClick={() => { void toggle(); }}>
        <PlaybackIcon playing={playing} />
      </button>
      <div className={styles.spectrum}>
        <img src={waveform} alt="" aria-hidden="true" />
        <canvas ref={canvas} width={320} height={32} aria-hidden="true" data-active={playing && Boolean(graph.current) || undefined} />
        <input type="range" min={0} max={duration || 1} step="0.1" value={Math.min(position, duration || 1)} disabled={!duration}
          aria-label={t('inspiration.media.seek', { name: item.name })} aria-valuetext={formatInspirationMediaTime(position)}
          onChange={event => { const value = Number(event.target.value); if (audio.current) audio.current.currentTime = value; setPosition(value); }} />
      </div>
      <span className={styles.duration}>{formatInspirationMediaTime(duration ? Math.max(0, duration - position) : position)}</span>
    </div>
    {failed && <p className={styles.playbackError} role="alert">{t('inspiration.media.playFailed')} <a href={inspirationMediaUrl(item.id)} download={item.name}>{t('inspiration.media.download')}</a></p>}
  </>;
}

function VisualAttachment({ item, motion, compact, onOpen, onAudioOnly }: {
  item: InspirationAttachment; motion?: InspirationAttachment; compact: boolean; onOpen?: () => void; onAudioOnly: () => void;
}) {
  const { t } = useTranslation();
  const movie = motion || (item.mimeType.startsWith('video/') ? item : undefined);
  const video = useRef<HTMLVideoElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const alive = useRef(true);
  const preview = item.mimeType === 'image/heic' || item.mimeType === 'image/heif';
  const [compatible, setCompatible] = useState(movie?.mimeType === 'video/quicktime');
  const movieUrl = movie ? inspirationMediaUrl(movie.id, compatible) : undefined;
  useEffect(() => {
    alive.current = true;
    const element = video.current;
    return () => { alive.current = false; element?.pause(); };
  }, []);
  useEffect(() => {
    const element = video.current, region = viewport.current;
    if (!compact || !element || !region) return;
    let visible = false, active = true;
    const update = () => {
      if (!active) return;
      if (!visible || document.hidden) { element.pause(); return; }
      void element.play().catch(error => {
        // Scrolling away or changing the source can interrupt a pending play.
        if (active && visible && !document.hidden && error?.name !== 'AbortError') setFailed(true);
      });
    };
    const observer = new IntersectionObserver(entries => {
      const entry = entries[entries.length - 1];
      if (!active || !entry) return;
      visible = entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
      update();
    });
    // A Live Photo's video can have zero width until its poster loads.
    // The containing viewport already has the final available width.
    observer.observe(region);
    document.addEventListener('visibilitychange', update);
    return () => {
      active = false; observer.disconnect(); document.removeEventListener('visibilitychange', update); element.pause();
    };
  }, [compact, movieUrl]);
  const toggle = async () => {
    const element = video.current;
    if (!element || pending) return;
    if (!element.paused) { element.pause(); return; }
    setPending(true);
    try { await element.play(); }
    catch { if (alive.current) setFailed(true); }
    finally { if (alive.current) setPending(false); }
  };
  const picture = <img className={styles.visualImage} src={inspirationMediaUrl(item.id, preview)} alt={item.name} loading="lazy" draggable={false} onError={() => setFailed(true)} />;
  const content = <>
      {(!movie || motion) && (compact ? picture : <a href={inspirationMediaUrl(item.id, preview)} target="_blank" rel="noreferrer" title={item.name}>{picture}</a>)}
      {movie && <>
        <video ref={video} className={styles.video} src={movieUrl} playsInline muted={compact} loop={compact} preload={motion ? 'none' : 'metadata'}
          aria-label={movie.name} onPlay={() => { setPlaying(true); setFailed(false); }} onPause={() => setPlaying(false)}
          onLoadedMetadata={event => {
            // File pickers label audio-only WebM/MP4 containers as video too.
            if (!motion && event.currentTarget.videoWidth === 0 && event.currentTarget.videoHeight === 0) onAudioOnly();
          }}
          onEnded={() => { setPlaying(false); if (video.current) video.current.currentTime = 0; }}
          onError={() => {
            if (!compatible && movie.mimeType === 'video/mp4') { setCompatible(true); setFailed(false); }
            else { setFailed(true); setPlaying(false); }
          }} />
        {!compact && <button type="button" className={styles.videoPlay} disabled={pending} aria-busy={pending || undefined}
          aria-label={t(playing ? 'inspiration.media.pause' : motion ? 'inspiration.media.playLive' : 'inspiration.media.play', { name: item.name })}
          onClick={() => { void toggle(); }}><PlaybackIcon playing={playing} />{motion && <span>{t('inspiration.media.live')}</span>}</button>}
      </>}
    </>;
  return <div ref={viewport} className={styles.visualViewport}>
    <div className={styles.visual} data-live={Boolean(motion) || undefined} data-playing={playing || undefined}>
      {compact && onOpen ? <button type="button" className={styles.visualOpen} onClick={onOpen} aria-label={item.name}>{content}</button> : content}
    </div>
    {failed && <p className={styles.playbackError} role="alert">{t('inspiration.media.previewFailed')} <a href={inspirationMediaUrl(movie?.id || item.id)} download={movie?.name || item.name}>{t('inspiration.media.download')}</a></p>}
  </div>;
}

type PreviewProps = {
  attachments?: InspirationAttachment[]; compact?: boolean; disabled?: boolean; onRemove?: (ids: string[]) => void; onOpen?: () => void;
};
function AttachmentPreview({ item, motion, compact, disabled, onRemove, onOpen }: Pick<PreviewProps, 'disabled' | 'onRemove' | 'onOpen'> & {
  item: InspirationAttachment; motion?: InspirationAttachment; compact: boolean;
}) {
  const { t } = useTranslation();
  const [audioOnly, setAudioOnly] = useState(false);
  const audio = item.mimeType.startsWith('audio/') || audioOnly;
  const document = isInspirationDocument(item.mimeType);
  return <div className={styles.attachment} data-kind={document ? 'file' : audio ? 'audio' : motion ? 'live' : item.mimeType.split('/')[0]}>
    {document ? <a className={styles.fileRow} href={inspirationMediaUrl(item.id)} download={item.name} title={t('inspiration.media.download')}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" aria-hidden="true">
        <path d="M9.5 1.5h-6a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-8z" vectorEffect="non-scaling-stroke" /><path d="M9.5 1.5v4h4" vectorEffect="non-scaling-stroke" />
      </svg><MediaFilename name={item.name} />
    </a> : <><MediaFilename name={item.name} onOpen={onOpen} />
      {audio ? <AudioAttachment item={item} /> : <VisualAttachment key={`${item.id}:${motion?.id || ''}`} item={item} motion={motion} compact={compact} onOpen={onOpen} onAudioOnly={() => setAudioOnly(true)} />}</>}
    {onRemove && <button type="button" className={styles.remove} disabled={disabled} aria-label={t('inspiration.media.remove', { name: item.name })}
      onClick={() => onRemove([item.id, ...(motion ? [motion.id] : [])])}><span aria-hidden="true">×</span></button>}
  </div>;
}

export default function InspirationMediaPreview({ attachments = [], compact = false, disabled = false, onRemove, onOpen }: PreviewProps) {
  if (!attachments.length) return null;
  return <div className={styles.attachments} data-compact={compact || undefined} data-card-interactive
    data-files={attachments.every(item => isInspirationDocument(item.mimeType)) || undefined}>
    {groupInspirationMedia(attachments).map(({ item, motion }) => <AttachmentPreview key={item.id} item={item} motion={motion}
      compact={compact} disabled={disabled} onRemove={onRemove} onOpen={onOpen} />)}
  </div>;
}
