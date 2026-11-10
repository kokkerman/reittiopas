// shared bits for the draggable sheets: the grab bar, the rubber band curve and deciding if a sheet ends up open or closed

export const FLICK_VELOCITY = 450;

export function rubber_band(distance: number, dimension: number, constant = 0.55): number {
  return (distance * dimension * constant) / (dimension + constant * distance);
}

// opening_velocity is the release speed in the direction that opens the sheet.
export function settles_open(opening_velocity: number, height: number, range: { min: number; max: number }): boolean {
  if (opening_velocity > FLICK_VELOCITY) {
    return true;
  }

  if (opening_velocity < -FLICK_VELOCITY) {
    return false;
  }

  return height > (range.min + range.max) / 2;
}

export function Grabber() {
  return (
    <div className="flex justify-center pt-1.5 pb-0.5">
      <div className="h-1 w-9 rounded-full bg-neutral-600" />
    </div>
  );
}
