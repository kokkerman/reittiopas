// the same idea as the bottom sheet but at the top of the screen ofcourse

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { animate, motion, useMotionValue, useTransform, type AnimationPlaybackControls } from "motion/react";
import { SHEET_SPRING, TOP_PANEL, TOP_PANEL_MOTION } from "../styles/panel_styles";
import { DragTracker } from "../utils/drag_tracker";
import { Grabber, rubber_band, settles_open } from "./sheet_drag";

// works for now
const BORDER = 2;
const TOP_PADDING = 12;

interface Props {
  expanded: boolean;
  on_expanded_change: (expanded: boolean) => void;
  can_collapse: boolean;
  summary: ReactNode;
  children: ReactNode;
}

interface SheetDrag {
  tracker: DragTracker;
  start_height: number;
}

export function TopSheet({ expanded, on_expanded_change, can_collapse, summary, children }: Props) {
  const sheet_ref = useRef<HTMLElement>(null);
  const full_ref = useRef<HTMLDivElement>(null);
  const summary_ref = useRef<HTMLDivElement>(null);
  const grab_ref = useRef<HTMLDivElement>(null);
  const height = useMotionValue(0);
  const progress = useMotionValue(expanded ? 1 : 0);
  const summary_opacity = useTransform(progress, function (open_fraction) {
    return 1 - open_fraction;
  });
  const [live, set_live] = useState(false);
  const target = useRef(expanded);
  const pending = useRef<{ to: boolean; velocity: number } | null>(null);
  const range = useRef({ min: 0, max: 0 });
  const running = useRef<AnimationPlaybackControls | null>(null);
  const drag = useRef<SheetDrag | null>(null);

  function measure() {
    const chrome_height = BORDER + TOP_PADDING + (grab_ref.current?.offsetHeight ?? 0);
    const min = chrome_height + (summary_ref.current?.offsetHeight ?? 0);
    const max = chrome_height + (full_ref.current?.offsetHeight ?? 0);

    range.current = { min, max: Math.max(max, min + 1) };
    return range.current;
  }

  useEffect(
    function () {
      return height.on("change", function (current_height) {
        const { min, max } = range.current;
        const open_fraction = (current_height - min) / (max - min);
        progress.set(Math.min(1, Math.max(0, open_fraction)));
      });
    },
    [height, progress],
  );

  function spring_to(to: boolean, velocity = 0) {
    target.current = to;

    if (!live) {
      height.set(sheet_ref.current?.offsetHeight ?? 0);
      pending.current = { to, velocity };
      set_live(true);
      return;
    }

    const { min, max } = measure();
    running.current?.stop();
    running.current = animate(height, to ? max : min, {
      ...SHEET_SPRING,
      velocity,
      onComplete() {
        if (target.current === to && !drag.current) {
          progress.set(to ? 1 : 0);
          set_live(false);
        }
      },
    });
  }

  useLayoutEffect(function () {
    if (live && pending.current) {
      const { to, velocity } = pending.current;
      pending.current = null;
      spring_to(to, velocity);
    }
  });

  useEffect(
    function () {
      if (expanded !== target.current) {
        spring_to(expanded);
      }
    },
    [expanded],
  );

  function follow_finger(wanted_height: number) {
    const { min, max } = measure();
    const lowest = can_collapse ? min : max;

    if (wanted_height > max) {
      height.set(max + rubber_band(wanted_height - max, 120));
    } else if (wanted_height < lowest) {
      height.set(lowest - rubber_band(lowest - wanted_height, 120));
    } else {
      height.set(wanted_height);
    }
  }

  function on_pointer_down(event: ReactPointerEvent) {
    running.current?.stop();

    const start_height = live ? height.get() : (sheet_ref.current?.offsetHeight ?? 0);
    drag.current = {
      tracker: new DragTracker(event.pointerId, event.clientY, event.timeStamp),
      start_height,
    };
  }

  function on_pointer_move(event: ReactPointerEvent) {
    const active_drag = drag.current;
    if (!active_drag || event.pointerId !== active_drag.tracker.pointer_id) return;

    const was_dragging = active_drag.tracker.has_moved;
    const is_dragging = active_drag.tracker.move(event.clientY, event.timeStamp);
    if (!is_dragging) return;

    if (!was_dragging) {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      height.set(active_drag.start_height);
      set_live(true);
    }

    if (!full_ref.current?.offsetParent) return;

    follow_finger(active_drag.start_height + active_drag.tracker.distance());
  }

  function on_pointer_up(event: ReactPointerEvent) {
    const ended_drag = drag.current;
    drag.current = null;
    if (!ended_drag || event.pointerId !== ended_drag.tracker.pointer_id) return;
    if (!ended_drag.tracker.has_moved) return;

    const velocity = ended_drag.tracker.velocity_at_release(event.timeStamp);
    const open = can_collapse ? settles_open(velocity, height.get(), range.current) : true;
    spring_to(open, velocity);

    if (open !== expanded) {
      on_expanded_change(open);
    }
  }

  function on_pointer_cancel() {
    drag.current = null;
    spring_to(target.current);
  }

  const handle = {
    onPointerDown: on_pointer_down,
    onPointerMove: on_pointer_move,
    onPointerUp: on_pointer_up,
    onPointerCancel: on_pointer_cancel,
    style: { touchAction: "pan-x" as const }, // yeah
  };

  const show_summary = live || !expanded;
  const show_full = live || expanded;

  return (
    <motion.section
      ref={sheet_ref}
      {...TOP_PANEL_MOTION}
      style={{ height: live ? height : "auto" }}
      // clip only while moving; at rest the place suggestions hang below the panel.
      className={`${TOP_PANEL} ${live ? "overflow-hidden" : ""}`}
    >
      <div className="relative px-3 pt-3">
        {show_full && (
          <motion.div ref={full_ref} style={{ opacity: live ? progress : 1 }}>
            {children}
          </motion.div>
        )}
        {show_summary && (
          <motion.div
            ref={summary_ref}
            {...handle}
            style={{ ...handle.style, opacity: live ? summary_opacity : 1 }}
            className={live ? "absolute inset-x-3 top-3" : ""}
          >
            {summary}
          </motion.div>
        )}
      </div>
      <div ref={grab_ref} {...handle} className="pb-1">
        <Grabber />
      </div>
    </motion.section>
  );
}
// smallest grabber ever but might improves motor skills