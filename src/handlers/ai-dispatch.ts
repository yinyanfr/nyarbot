export function getDismissRetryCount(params: {
  action: "send" | "dismiss";
  tier: "simple" | "complex" | "tech";
  triggered: boolean;
  dismissReason?: string;
}): number {
  if (
    params.action !== "dismiss" ||
    !params.triggered ||
    params.dismissReason === "twitter_fetch_failed" ||
    params.tier === "tech"
  )
    return 0;
  return 1;
}
