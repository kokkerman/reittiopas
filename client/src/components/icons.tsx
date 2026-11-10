// the svg icons used around the app (big ups claude)

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ path_data, ...props }: { path_data: string } & IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={path_data} />
    </svg>
  );
}

export function ChevronLeft(props: IconProps) {
  return <Icon path_data="M15 18l-6-6 6-6" {...props} />;
}

export function ChevronRight(props: IconProps) {
  return <Icon path_data="M9 18l6-6-6-6" {...props} />;
}

export function ChevronUp(props: IconProps) {
  return <Icon path_data="M18 15l-6-6-6 6" {...props} />;
}

export function ChevronDown(props: IconProps) {
  return <Icon path_data="M6 9l6 6 6-6" {...props} />;
}

export function Close(props: IconProps) {
  return <Icon path_data="M18 6L6 18M6 6l12 12" {...props} />;
}

export function Swap(props: IconProps) {
  return <Icon path_data="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4" {...props} />;
}

export function Locate(props: IconProps) {
  return <Icon path_data="M12 2v3M12 19v3M2 12h3M19 12h3M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" {...props} />;
}

export function Search(props: IconProps) {
  return <Icon path_data="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5" {...props} />;
}
