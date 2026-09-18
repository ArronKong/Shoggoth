// Web Audio mixes this effect with other audio without taking over Media Session
// controls. Keep one decoded buffer for the lifetime of the screen prompt.
export function createTypewriterSound() {
  let context: AudioContext | null = null;
  let buffer: Promise<AudioBuffer> | null = null;
  let source: AudioBufferSourceNode | null = null;
  let gain: GainNode | null = null;
  let typing = false;
  let disposed = false;
  let generation = 0;
  const abort = new AbortController();

  const play = async () => {
    if (!typing || disposed || source || !window.AudioContext) return;
    const request = ++generation;
    try {
      // On macOS, opening a duplex USB output can trigger a native microphone
      // prompt even for playback, outside Electron's media permission handlers.
      // This ambient effect must stay silent until recording has been authorized.
      const desktop = (window as unknown as { openclawDesktop?: { getMicrophoneAccessStatus?: () => Promise<string> } }).openclawDesktop;
      if (desktop?.getMicrophoneAccessStatus && await desktop.getMicrophoneAccessStatus() !== 'granted') return;
      if (disposed || !typing || request !== generation) return;
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
