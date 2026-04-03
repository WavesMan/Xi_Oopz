type CueKind = "chat" | "join" | "leave";

class SoundManager {
  private context: AudioContext | null = null;

  async play(kind: CueKind) {
    try {
      const context = this.ensureContext();
      await context.resume();
      this.playCue(context, kind);
    } catch (error) {
      console.error("sound playback failed", error);
    }
  }

  private ensureContext() {
    if (!this.context) {
      this.context = new AudioContext();
    }
    return this.context;
  }

  private playCue(context: AudioContext, kind: CueKind) {
    const now = context.currentTime + 0.01;
    const notes =
      kind === "chat"
        ? [
            { freq: 784, offset: 0, duration: 0.075, gain: 0.035, type: "triangle" as const },
            { freq: 1046, offset: 0.055, duration: 0.1, gain: 0.025, type: "sine" as const },
          ]
        : kind === "join"
          ? [
              { freq: 440, offset: 0, duration: 0.085, gain: 0.04, type: "sine" as const },
              { freq: 659, offset: 0.065, duration: 0.12, gain: 0.03, type: "triangle" as const },
            ]
          : [
              { freq: 660, offset: 0, duration: 0.08, gain: 0.04, type: "triangle" as const },
              { freq: 392, offset: 0.055, duration: 0.14, gain: 0.03, type: "sine" as const },
            ];

    for (const note of notes) {
      const start = now + note.offset;
      const end = start + note.duration;
      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.type = note.type;
      oscillator.frequency.setValueAtTime(note.freq, start);

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(note.gain, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);

      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(end + 0.02);
    }
  }
}

export const soundManager = new SoundManager();
