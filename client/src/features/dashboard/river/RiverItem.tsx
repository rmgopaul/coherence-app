import { cn } from "@/lib/utils";
import type { RiverItem as RiverItemData } from "./buildRiver";

const KIND_LABEL: Record<RiverItemData["kind"], string> = {
  cal: "CAL",
  task: "TASK",
  mail: "MAIL",
  file: "FILE",
};

export function RiverItem({ item }: { item: RiverItemData }) {
  const Tag = item.href ? "a" : "div";
  const tagProps = item.href
    ? { href: item.href, target: "_blank", rel: "noopener noreferrer" }
    : {};
  return (
    <Tag
      {...tagProps}
      className={cn(
        "fp-river-item",
        `fp-river-item--${item.kind}`,
        `fp-river-item--${item.size}`
      )}
    >
      <time className="fp-river-item__time mono-label">{item.timeLabel}</time>
      <span className={`fp-river-item__kind fp-river-item__kind--${item.kind}`}>
        {KIND_LABEL[item.kind]}
      </span>
      <h3 className="fp-river-item__title">{item.title}</h3>
      {item.meta && <span className="fp-river-item__meta">{item.meta}</span>}
    </Tag>
  );
}

export default RiverItem;
