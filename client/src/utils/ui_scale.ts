// ui scaling stuff

let cached_scale: number | null = null;

function forget_cached_scale() {
  cached_scale = null;
}

export function ui_scale(): number {
  if (cached_scale === null) {
    const root_font_size = parseFloat(getComputedStyle(document.documentElement).fontSize);
    cached_scale = root_font_size / 16 || 1;
    window.addEventListener("resize", forget_cached_scale, { once: true });
  }

  return cached_scale;
}
