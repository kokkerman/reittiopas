// general formatting helpers

const MILLISECONDS_PER_MINUTE = 60000;

export function format_clock_time(unix_seconds: number): string {
  const date = new Date(unix_seconds * 1000);

  return date.toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" });
}

// hour minute format
export function format_minutes(total_minutes: number): string {
  const hours = Math.floor(total_minutes / 60);
  const minutes = total_minutes % 60;

  if (hours === 0) {
    return `${minutes} min`;
  }

  if (minutes === 0) {
    return `${hours} h`;
  }

  return `${hours} h ${minutes} min`;
}

export function format_duration(seconds: number): string {
  const total_minutes = Math.max(1, Math.round(seconds / 60));

  return format_minutes(total_minutes);
}

export function minutes_until(unix_seconds: number, now_ms: number): number {
  return Math.round((unix_seconds * 1000 - now_ms) / MILLISECONDS_PER_MINUTE);
}

// human readable format for countdowns
export function format_countdown(unix_seconds: number, now_ms: number): string {
  const minutes = minutes_until(unix_seconds, now_ms);

  if (minutes <= 0) {
    return "Nyt";
  }

  if (minutes < 60) {
    return `${minutes} min`;
  }

  return format_clock_time(unix_seconds);
}

// human redable format for relative times
export function format_relative_time(unix_seconds: number | null, now: Date): string {
  if (unix_seconds === null) {
    return "Nyt";
  }

  const minutes = minutes_until(unix_seconds, now.getTime());

  if (minutes === 0) {
    return "Nyt";
  }

  const span = format_minutes(Math.abs(minutes));

  if (minutes > 0) {
    return `${span} päästä`;
  }

  return `${span} sitten`;
}
