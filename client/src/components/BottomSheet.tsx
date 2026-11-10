// the "main" panel at the bottom of the screen

// TODO: make the drags a shared framework instead of this redundant shit

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { animate, motion, useMotionValue, type AnimationPlaybackControls } from "motion/react";
import { BOTTOM_PANEL_MOTION, BOTTOM_PANEL_POSITION, PANEL_SURFACE, SHEET_SPRING } from "../styles/panel_styles";
import { DragTracker } from "../utils/drag_tracker";
import { FLICK_VELOCITY, Grabber, rubber_band, settles_open } from "./sheet_drag";


// arbitrary constants but feels fine
const DISMISS_PULL = 70;
const FLICK_DISMISS_MIN_PULL = 10;
const BORDER = 2;

interface Props {
  expanded: boolean;
  on_expanded_change: (expanded: boolean) => void;
  on_dismiss?: () => void;
  head: ReactNode;
  children: ReactNode;
  className?: string;
}

interface SheetDrag {
  tracker: DragTracker;
  start_height: number;
}

export function BottomSheet({ expanded, on_expanded_change, on_dismiss, head, children, className: class_name = "" }: Props) {
  const sheet_ref = useRef<HTMLElement>(null);
  const head_ref = useRef<HTMLDivElement>(null);
  const body_ref = useRef<HTMLDivElement>(null);
  const content_ref = useRef<HTMLDivElement>(null);
  const height = useMotionValue(0);
  const pull = useMotionValue(0);
  const [live, set_live] = useState(false);
  const target = useRef(expanded);
  const pending_to = useRef<{ to: boolean; velocity: number } | null>(null);
  const drag = useRef<SheetDrag | null>(null);
  const running = useRef<AnimationPlaybackControls[]>([]);
  
  const cap = useRef(Infinity); // rushed fix for over dragging 
  
  function measure() {
    const sheet = sheet_ref.current!;
    if (!live) {
      const css_max_height = parseFloat(getComputedStyle(sheet).maxHeight);
      cap.current = Number.isFinite(css_max_height) ? css_max_height : Infinity;
    }
    
    const head_height = head_ref.current!.offsetHeight;
    const full_height = head_height + content_ref.current!.offsetHeight + BORDER;
    
    return { min: head_height + BORDER, max: Math.min(cap.current, full_height) };
  }
  
  function stop_animations() {
    for (const animation of running.current) {
      animation.stop();
    }
    running.current = [];
  }
  
  function spring_to(to: boolean, velocity = 0) {
    target.current = to;
    
    if (!live) {
      measure();
      height.set(sheet_ref.current?.offsetHeight ?? 0);
      pending_to.current = { to, velocity };
      set_live(true);
      return;
    }
    
    const { min, max } = measure();
    stop_animations();
    running.current = [
      animate(pull, 0, SHEET_SPRING),
      animate(height, to ? max : min, {
        ...SHEET_SPRING,
        velocity,
        onComplete() {
          if (target.current === to && !drag.current) {
            set_live(false);
          }
        },
      }),
    ];
  }

  useLayoutEffect(function () {
    if (live && pending_to.current) {
      const { to, velocity } = pending_to.current;
      pending_to.current = null;
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

  function on_pointer_down(event: ReactPointerEvent) {
    if (!live) {
      measure();
    }
    stop_animations();

    const start_height = live ? height.get() : (sheet_ref.current?.offsetHeight ?? 0);
    drag.current = {
      tracker: new DragTracker(event.pointerId, event.clientY, event.timeStamp),
      start_height,
    };
  }

  function follow_finger(wanted_height: number) {
    const { min, max } = measure();

    if (wanted_height > max) {
      height.set(max + rubber_band(wanted_height - max, 160));
      pull.set(0);
    } else if (wanted_height < min) {
      const overshoot = min - wanted_height;
      height.set(min);
      pull.set(on_dismiss ? overshoot : rubber_band(overshoot, 120));
    } else {
      height.set(wanted_height);
      pull.set(0);
    }
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

    if (!body_ref.current?.offsetParent) return;

    follow_finger(active_drag.start_height - active_drag.tracker.distance());
  }

  function on_pointer_up(event: ReactPointerEvent) {
    const ended_drag = drag.current;
    drag.current = null;
    if (!ended_drag || event.pointerId !== ended_drag.tracker.pointer_id) return;
    if (!ended_drag.tracker.has_moved) return;

    const velocity = ended_drag.tracker.velocity_at_release(event.timeStamp);
    const pulled_far_enough = pull.get() > DISMISS_PULL;
    const flicked_down = pull.get() > FLICK_DISMISS_MIN_PULL && velocity > FLICK_VELOCITY;

    if (on_dismiss && (pulled_far_enough || flicked_down)) {
      on_dismiss();
      return;
    }

    // moving up (negative velocity) opens this sheet.
    const open = settles_open(-velocity, height.get(), measure());
    spring_to(open, -velocity);

    if (open !== expanded) {
      on_expanded_change(open);
    }
  }

  const body_hidden = !live && !expanded;

  return (
    <motion.div {...BOTTOM_PANEL_MOTION} className={BOTTOM_PANEL_POSITION}>
      <motion.aside
        ref={sheet_ref}
        style={{ height: live ? height : "auto", maxHeight: live ? "none" : undefined, y: pull }}
        className={`flex flex-col overflow-hidden ${PANEL_SURFACE} ${class_name}`}
      >
        <div
          ref={head_ref}
          onPointerDown={on_pointer_down}
          onPointerMove={on_pointer_move}
          onPointerUp={on_pointer_up}
          onPointerCancel={on_pointer_up}
          className="shrink-0"
          style={{ touchAction: "pan-x" }} // big ups claude
        >
          <Grabber />
          {head}
        </div>
        <div ref={body_ref} className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${body_hidden ? "hidden" : ""}`}>
          <div ref={content_ref}>{children}</div>
        </div>
      </motion.aside>
    </motion.div>
  );
}
