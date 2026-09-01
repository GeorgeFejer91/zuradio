const BAR_COUNT = 48;

export interface SpectrumSource {
  readSpectrum(target: Uint8Array): boolean;
}

export class SvgSoundVisualizer {
  private svg: SVGSVGElement | null = null;
  private source: SpectrumSource | null = null;
  private bars: SVGLineElement[] = [];
  private frame = 0;
  private lastFrame = 0;
  private readonly values = new Uint8Array(BAR_COUNT);
  private readonly levels = new Float32Array(BAR_COUNT);
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  mount(svg: SVGSVGElement | null, source: SpectrumSource): void {
    cancelAnimationFrame(this.frame);
    this.svg = svg;
    this.source = source;
    this.bars = Array.from(svg?.querySelectorAll<SVGLineElement>("[data-spectrum-bar]") ?? []);
    this.lastFrame = 0;
    if (this.svg) this.frame = requestAnimationFrame((time) => this.tick(time));
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.svg = null;
    this.source = null;
    this.bars = [];
  }

  private tick(time: number): void {
    if (!this.svg || !this.source) return;
    if (!document.hidden && !this.reducedMotion.matches && time - this.lastFrame >= 32) {
      const active = this.source.readSpectrum(this.values);
      for (let index = 0; index < this.bars.length; index += 1) {
        const sample = active ? (this.values[index] ?? 0) / 255 : 0;
        const target = active ? Math.max(0.035, sample ** 1.35) : 0.025;
        this.levels[index] = Math.max(target, (this.levels[index] ?? 0) * 0.82);
        const halfHeight = 2 + (this.levels[index] ?? 0) * 39;
        this.bars[index]?.setAttribute("y1", (48 - halfHeight).toFixed(2));
        this.bars[index]?.setAttribute("y2", (48 + halfHeight).toFixed(2));
      }
      this.svg.dataset.active = active ? "true" : "false";
      this.lastFrame = time;
    }
    this.frame = requestAnimationFrame((next) => this.tick(next));
  }
}

export function renderSoundVisualizer(testId: string): string {
  const bars = Array.from({ length: BAR_COUNT }, (_, index) => {
    const x = 10 + index * 20;
    return `<line data-spectrum-bar x1="${x}" x2="${x}" y1="46" y2="50" />`;
  }).join("");
  return `<svg class="sound-visualizer" data-testid="${testId}" viewBox="0 0 960 96" preserveAspectRatio="none" role="presentation" aria-hidden="true"><line class="visualizer-axis" x1="0" x2="960" y1="48" y2="48" /><g>${bars}</g></svg>`;
}
