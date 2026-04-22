import { CAMPAIGN_STATUS_COLORS, CAMPAIGN_STATUS_LABELS } from "@/lib/constants";

export function CampaignStatus({ status }: { status: string }) {
  const color = CAMPAIGN_STATUS_COLORS[status] ?? "bg-white/10 text-white";
  const label = CAMPAIGN_STATUS_LABELS[status] ?? status;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${color}`}
    >
      {label}
    </span>
  );
}
