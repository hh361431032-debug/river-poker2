let audioContext = null;

function getContext() {
  if (typeof window === "undefined") return null;
  if (!audioContext) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioContext = new Ctx();
  }
  return audioContext;
}

const TONES = {
  click: [520, 0.045, "sine"],
  call: [620, 0.06, "triangle"],
  fold: [180, 0.09, "sawtooth"],
  deal: [760, 0.07, "triangle"],
  throw: [260, 0.08, "square"],
};

export function playSound(name = "click") {
  const ctx = getContext();
  const spec = TONES[name] || TONES.click;
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") ctx.resume();
    const [frequency, duration, type] = spec;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.035, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch {}
}
