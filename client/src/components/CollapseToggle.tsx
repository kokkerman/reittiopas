// the little arrow button that minimises a panel or opens it again

import { ChevronDown, ChevronUp } from "./icons";

interface Props {
  collapsed: boolean;
  onToggle: () => void;
}

export function CollapseToggle({ collapsed, onToggle: on_toggle }: Props) {
  return (
    <button
      onClick={on_toggle}
      aria-label={collapsed ? "Näytä lisää" : "Pienennä"}
      aria-expanded={!collapsed}
      className="shrink-0 p-1.5 text-xl text-neutral-400"
    >
      {collapsed ? <ChevronUp /> : <ChevronDown />}
    </button>
  );
}
