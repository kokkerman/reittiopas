// shared bits and pieces used somethings somewhere

import { mode_color } from "../styles/mode_colors";
import { format_clock_time } from "../utils/time_format";

interface LineTagProps {
  line: string;
  mode: string | null | undefined;
  large?: boolean;
}

export function LineTag({ line, mode, large = false }: LineTagProps) {
  const size_classes = large ? "min-w-12 px-2 py-0.5 text-base" : "min-w-9 px-1.5 text-sm";

  return (
    <span
      className={`inline-block shrink-0 rounded-md text-center font-bold text-white tabular-nums ${size_classes}`}
      style={{ background: mode_color(mode) }}
    >
      {line}
    </span>
  );
}

interface DelayStatusProps {
  delaySeconds: number;
  realtime?: boolean;
  cancelled?: boolean;
}

function delay_status(delay_seconds: number, realtime: boolean, cancelled: boolean): { color: string; text: string } {
  if (cancelled) {
    return { color: "bg-red-500", text: "Peruttu" };
  }

  if (!realtime) {
    return { color: "bg-neutral-500", text: "Aikataulu" };
  }

  const delay_minutes = Math.round(delay_seconds / 60);

  if (delay_minutes > 0) {
    return { color: "bg-red-500", text: `${delay_minutes} min myöhässä` };
  }

  if (delay_minutes < 0) {
    return { color: "bg-amber-400", text: `${-delay_minutes} min etuajassa` };
  }

  return { color: "bg-emerald-500", text: "Ajallaan" };
}

export function DelayStatus({ delaySeconds: delay_seconds, realtime = true, cancelled = false }: DelayStatusProps) {
  const { color, text } = delay_status(delay_seconds, realtime, cancelled);

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-neutral-400">
      <span className={`size-1.5 rounded-full ${color}`} />
      {text}
    </span>
  );
}

interface ClockTimeWithScheduleProps {
  estimated_time: number;
  scheduled_time: number;
  realtime: boolean;
}

export function ClockTimeWithSchedule({ estimated_time, scheduled_time, realtime }: ClockTimeWithScheduleProps) {
  const estimated_clock = format_clock_time(estimated_time);
  const scheduled_clock = format_clock_time(scheduled_time);
  const changed = realtime && estimated_clock !== scheduled_clock;

  return (
    <div className="text-xs text-neutral-500 tabular-nums">
      {changed && <span className="mr-1 line-through">{scheduled_clock}</span>}
      {estimated_clock}
    </div>
  );
}
