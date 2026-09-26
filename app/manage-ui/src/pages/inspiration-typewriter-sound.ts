// Web Audio mixes this effect with other audio without taking over Media Session
// controls. On macOS without microphone access, native output-only playback
// avoids opening a duplex USB device merely to play the ambient effect.
export function createTypewriterSound() {
  let context: AudioContext | null = null;
  let buffer: Promise<AudioBuffer> | null = null;
  let source: AudioBufferSourceNode | null = null;
  let gain: GainNode | null = null;
  let nativePlaying = false;
  let typing = false;
  let disposed = false;
  let generation = 0;
  const abort = new AbortController();
  const desktop = (window as unknown as { openclawDesktop?: {
    getMicrophoneAccessStatus?: () => Promise<string>;
    typewriterSound?: { start: () => void; stop: () => void };
  } }).openclawDesktop;

  const play = async () => {
    if (!typing || disposed || source || nativePlaying) return;
    const request = ++generation;
    try {
      const status = desktop?.getMicrophoneAccessStatus
        ? await desktop.getMicrophoneAccessStatus().catch(() => 'unknown') : undefined;
      if (disposed || !typing || request !== generation) return;
      if ((status !== undefined && status !== 'granted') || !window.AudioContext) {
        desktop?.typewriterSound?.start();
        nativePlaying = Boolean(desktop?.typewriterSound);
        return;
      }
      const audio = context ??= new AudioContext();
      buffer ??= fetch('/audio/typewriter-loop.wav', { signal: abort.signal })
        .then(response => {
          if (!response.ok) throw new Error('Typewriter audio unavailable');
          return response.arrayBuffer();
        }).then(data => audio.decodeAudioData(data)).catch(error => { buffer = null; throw error; });
      const decoded = await buffer;
      if (disposed || !typing || request !== generation) return;
      // A browser may wait for a user gesture. Recheck after resume so collapsing
      // or navigating away during that wait can never start a late sound.
      await audio.resume();
      if (disposed || !typing || request !== generation) return;
      gain ??= audio.createGain();
      gain.gain.value = .3;
      gain.connect(audio.destination);
      source = audio.createBufferSource();
      source.buffer = decoded;
      source.loop = true;
      source.playbackRate.value = 2.5;
      source.connect(gain);
      source.start(0, Math.random() * Math.min(20, decoded.duration));
    } catch { /* Missing audio or autoplay denial must leave the screen usable. */ }
  };
  const stop = () => {
    generation++;
    if (nativePlaying) {
      nativePlaying = false;
      try { desktop?.typewriterSound?.stop(); } catch { /* Renderer teardown can revoke IPC first. */ }
    }
    source?.stop();
    source?.disconnect();
    source = null;
    gain?.disconnect();
    if (context?.state === 'running') void context.suspend().catch(() => {});
  };
  const unlock = () => { if (typing) void play(); };
  document.addEventListener('pointerdown', unlock);
  document.addEventListener('keydown', unlock);

  return {
    setTyping(value: boolean) {
      if (disposed || value === typing) return;
      typing = value;
      if (typing) void play();
      else stop();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      typing = false;
      stop();
      abort.abort();
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
      if (context) void context.close().catch(() => {});
    },
  };
}
