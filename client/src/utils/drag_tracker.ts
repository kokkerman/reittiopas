// follows a finger or mouse while dragging and works out how fast it moved, for the drags

const STALE_RELEASE_MS = 80;

// movement before a press counts as a drag, so taps on buttons still work.
export const TAP_SLOP_PX = 6;


export class DragTracker {
  readonly pointer_id: number;
  readonly start_y: number;
  has_moved = false;

  private last_y: number;
  private last_time: number;
  private velocity = 0;

  constructor(pointer_id: number, start_y: number, start_time: number) {
    this.pointer_id = pointer_id;
    this.start_y = start_y;
    this.last_y = start_y;
    this.last_time = start_time;
  }

  distance(): number {
    return this.last_y - this.start_y;
  }

  // records a move; returns true once the pointer has travelled past the tap slop.
  move(y: number, time: number): boolean {
    const elapsed_ms = Math.max(1, time - this.last_time);
    const instant_velocity = ((y - this.last_y) / elapsed_ms) * 1000;

    // smooth out jitter between move events.
    this.velocity = 0.7 * instant_velocity + 0.3 * this.velocity;
    this.last_y = y;
    this.last_time = time;

    if (!this.has_moved && Math.abs(this.distance()) >= TAP_SLOP_PX) {
      this.has_moved = true;
    }

    return this.has_moved;
  }

  velocity_at_release(release_time: number): number {
    const held_still = release_time - this.last_time > STALE_RELEASE_MS;

    return held_still ? 0 : this.velocity;
  }
}
