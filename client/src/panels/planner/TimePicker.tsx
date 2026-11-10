// the scrollable clock for picking the departure time, or the latest time to arrive
// shoutout claude!

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ui_scale } from "../../utils/ui_scale";
import { format_relative_time } from "../../utils/time_format";

const SETTLE_MS = 120;
const PAST_GRACE_MS = 15 * 60000;
const DRAG_SLOP_PX = 4;
const WHEEL_NOTCH_PX = 30;
const PIXELS_PER_WHEEL_LINE = 30;

const HOURS = Array.from({ length: 24 }, function (_, i) {
  return i;
});
const MINUTES = Array.from({ length: 60 }, function (_, i) {
  return i;
});

function row_height() {
  return Math.round(26 * ui_scale());
}

function two_digits(value: number) {
  return String(value).padStart(2, "0");
}

interface WheelProps {
  items: number[];
  value: number;
  onSelect: (value: number) => void;
  label: string;
}

function Wheel({ items, value, onSelect: on_select, label }: WheelProps) {
  const item_height = row_height();
  const list_ref = useRef<HTMLDivElement>(null);
  const [center, set_center] = useState(function () {
    return Math.max(0, items.indexOf(value));
  });
  const [dragging, set_dragging] = useState(false);
  const interacting = useRef(false);
  const settle = useRef<number | undefined>(undefined);
  const latest = useRef({ value, on_select });
  latest.current = { value, on_select };
  // a press only becomes a drag after a few px of movement, so clicking a number still works.
  const press = useRef<{ y: number; top: number } | null>(null);
  const drag_ref = useRef<{ y: number; top: number } | null>(null);

  function clamp_index(index: number) {
    return Math.min(items.length - 1, Math.max(0, index));
  }

  function row_at(scroll_top: number) {
    return Math.round(scroll_top / item_height);
  }

  function scroll_to_index(index: number, smooth = true) {
    list_ref.current?.scrollTo({ top: clamp_index(index) * item_height, behavior: smooth ? "smooth" : "instant" });
  }

  function move_to_row(index: number) {
    interacting.current = true;
    scroll_to_index(index);
  }

  useLayoutEffect(
    function () {
      if (interacting.current || !list_ref.current) return;

      const index = Math.max(0, items.indexOf(value));
      list_ref.current.scrollTop = index * item_height;
      set_center(index);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value, items],
  );

  function schedule_settle() {
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(function () {
      const list = list_ref.current;
      if (!list || drag_ref.current) return;

      const index = clamp_index(row_at(list.scrollTop));
      const off_row = Math.abs(list.scrollTop - index * item_height) > 1;
      if (off_row) {
        scroll_to_index(index);
        return;
      }

      interacting.current = false;
      if (items[index] !== latest.current.value) {
        latest.current.on_select(items[index]);
      }
    }, SETTLE_MS);
  }

  function on_scroll() {
    const list = list_ref.current;
    if (!list) return;

    set_center(clamp_index(row_at(list.scrollTop)));
    schedule_settle();
  }

  // wheel: one row per notch. Needs a non-passive listener to stop the native scroll.
  useEffect(
    function () {
      const list_or_null = list_ref.current;
      if (!list_or_null) return;

      const list = list_or_null;
      let accumulated = 0;
      function on_wheel(event: WheelEvent) {
        event.preventDefault();

        const scrolls_by_lines = event.deltaMode === 1;
        accumulated += scrolls_by_lines ? event.deltaY * PIXELS_PER_WHEEL_LINE : event.deltaY;
        if (Math.abs(accumulated) < WHEEL_NOTCH_PX) return;

        const step = Math.sign(accumulated);
        accumulated = 0;
        move_to_row(row_at(list.scrollTop) + step);
      }

      list.addEventListener("wheel", on_wheel, { passive: false });
      return function () {
        list.removeEventListener("wheel", on_wheel);
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items.length],
  );

  function on_pointer_down(event: PointerEvent<HTMLDivElement>) {
    interacting.current = true;
    if (event.pointerType !== "mouse" || !list_ref.current) return;

    press.current = { y: event.clientY, top: list_ref.current.scrollTop };
  }

  function on_pointer_move(event: PointerEvent<HTMLDivElement>) {
    const list = list_ref.current;
    if (!list) return;

    const pressed = press.current;
    const moved_past_slop = pressed !== null && Math.abs(event.clientY - pressed.y) > DRAG_SLOP_PX;
    const starts_drag = !drag_ref.current && moved_past_slop;
    if (starts_drag) {
      drag_ref.current = pressed;
      event.currentTarget.setPointerCapture(event.pointerId);
      set_dragging(true);
    }

    const drag = drag_ref.current;
    if (drag) {
      list.scrollTop = drag.top - (event.clientY - drag.y);
    }
  }

  function end_drag() {
    const was_drag = drag_ref.current !== null;
    press.current = null;
    drag_ref.current = null;
    set_dragging(false);

    if (was_drag && list_ref.current) {
      scroll_to_index(row_at(list_ref.current.scrollTop));
    }
    schedule_settle();
  }

  function on_touch_start() {
    interacting.current = true;
  }

  function on_key_down(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;

    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    move_to_row(center + step);
  }

  const drag_classes = dragging ? "cursor-grabbing" : "cursor-grab snap-y snap-mandatory";

  return (
    <div
      ref={list_ref}
      role="listbox"
      aria-label={label}
      tabIndex={0}
      onScroll={on_scroll}
      onPointerDown={on_pointer_down}
      onPointerMove={on_pointer_move}
      onPointerUp={end_drag}
      onPointerCancel={end_drag}
      onTouchStart={on_touch_start}
      onTouchEnd={schedule_settle}
      onKeyDown={on_key_down}
      className={`relative w-11 touch-pan-y overflow-y-scroll overscroll-contain outline-none ${drag_classes}`}
      style={{
        height: item_height * 3,
        scrollbarWidth: "none",
        maskImage: "linear-gradient(transparent, black 30%, black 70%, transparent)",
      }}
    >
      <div style={{ height: item_height }} />
      {items.map(function (item, i) {
        const is_center = i === center;
        const state_classes = is_center ? "font-semibold text-neutral-100" : "text-sm text-neutral-500";

        return (
          <div
            key={item}
            role="option"
            aria-selected={is_center}
            onClick={function () {
              move_to_row(i);
            }}
            className={`flex snap-center items-center justify-center tabular-nums transition-colors ${state_classes}`}
            style={{ height: item_height }}
          >
            {two_digits(item)}
          </div>
        );
      })}
      <div style={{ height: item_height }} />
    </div>
  );
}

function use_now(step_ms = 10000) {
  const [now, set_now] = useState(function () {
    return new Date();
  });

  useEffect(
    function () {
      const timer = setInterval(function () {
        set_now(new Date());
      }, step_ms);

      return function () {
        clearInterval(timer);
      };
    },
    [step_ms],
  );

  return now;
}

export type TimeTab = "depart" | "arrive";

function Toggle({ on, onChange: on_change, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  function flip() {
    on_change(!on);
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={flip}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? "bg-blue-500" : "bg-neutral-600"}`}
    >
      <span className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white transition-transform ${on ? "translate-x-4" : ""}`} />
    </button>
  );
}

const TABS: { value: TimeTab; label: string }[] = [
  { value: "depart", label: "Lähtö" },
  { value: "arrive", label: "Perillä" },
];

interface TimePickerProps {
  tab: TimeTab;
  onTab: (tab: TimeTab) => void;
  departTime: number | null;
  onDepart: (time: number | null) => void;
  arriveTime: number | null;
  onArrive: (time: number | null) => void;
  arriveLimit: boolean;
  onArriveLimit: (on: boolean) => void;
}

export default function TimePicker({
  tab,
  onTab: on_tab,
  departTime: depart_time,
  onDepart: on_depart,
  arriveTime: arrive_time,
  onArrive: on_arrive,
  arriveLimit: arrive_limit,
  onArriveLimit: on_arrive_limit,
}: TimePickerProps) {
  const item_height = row_height();
  const now = use_now();
  const arriving = tab === "arrive";
  const time = arriving ? arrive_time : depart_time;
  const shown_time = time === null ? now : new Date(time * 1000);

  function set_clock_time(hour: number, minute: number) {
    const chosen = new Date(now);
    chosen.setHours(hour, minute, 0, 0);

    // a time that has already passed means that time tomorrow.
    const already_passed = chosen.getTime() < now.getTime() - PAST_GRACE_MS;
    if (already_passed) {
      chosen.setDate(chosen.getDate() + 1);
    }

    const unix_seconds = Math.floor(chosen.getTime() / 1000);

    if (!arriving) {
      on_depart(unix_seconds);
      return;
    }

    on_arrive(unix_seconds);
    if (!arrive_limit) {
      on_arrive_limit(true);
    }
  }

  function select_hour(hour: number) {
    set_clock_time(hour, shown_time.getMinutes());
  }

  function select_minute(minute: number) {
    set_clock_time(shown_time.getHours(), minute);
  }

  const wheels_dimmed = arriving && !arrive_limit;

  return (
    <div className="flex items-center justify-between rounded-xl bg-neutral-800 pr-2 pl-2">
      <div className="flex flex-col gap-1.5">
        <div role="tablist" aria-label="Aika" className="flex rounded-lg bg-neutral-900 p-0.5 text-sm">
          {TABS.map(function (option) {
            const selected = tab === option.value;
            const state_classes = selected ? "bg-neutral-700 font-semibold text-white" : "text-neutral-400";
            const show_limit_dot = option.value === "arrive" && arrive_limit;

            return (
              <button
                key={option.value}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={function () {
                  on_tab(option.value);
                }}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors ${state_classes}`}
              >
                {option.label}
                {show_limit_dot && <span className="size-1.5 rounded-full bg-blue-400" />}
              </button>
            );
          })}
        </div>
        {arriving ? (
          <ArriveLimitRow
            arrive_limit={arrive_limit}
            arrive_time={arrive_time}
            now={now}
            on_arrive_limit={on_arrive_limit}
          />
        ) : (
          <div className="pl-1 text-sm">{format_relative_time(depart_time, now)}</div>
        )}
      </div>
      <div className={`relative flex items-center transition-opacity ${wheels_dimmed ? "opacity-40" : ""}`}>
        <div
          className="pointer-events-none absolute inset-x-0 rounded-lg bg-neutral-700/60"
          style={{ top: item_height, height: item_height }}
        />
        <Wheel label="Tunnit" items={HOURS} value={shown_time.getHours()} onSelect={select_hour} />
        <span className="relative font-semibold">:</span>
        <Wheel label="Minuutit" items={MINUTES} value={shown_time.getMinutes()} onSelect={select_minute} />
      </div>
    </div>
  );
}

interface ArriveLimitRowProps {
  arrive_limit: boolean;
  arrive_time: number | null;
  now: Date;
  on_arrive_limit: (on: boolean) => void;
}

function ArriveLimitRow({ arrive_limit, arrive_time, now, on_arrive_limit }: ArriveLimitRowProps) {
  const limit_text = arrive_limit ? format_relative_time(arrive_time, now) : "Ei rajaa";

  return (
    <label className="flex items-center gap-2 pl-1 text-sm">
      <Toggle on={arrive_limit} onChange={on_arrive_limit} label="Perillä viimeistään" />
      <span className={arrive_limit ? "" : "text-neutral-500"}>{limit_text}</span>
    </label>
  );
}
