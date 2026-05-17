import {
  BillingRouteSkeleton,
  DashboardContentRouteSkeleton,
} from "../../../_components/route-loading-skeleton";

export default function Loading() {
  return (
    <DashboardContentRouteSkeleton>
      <BillingRouteSkeleton />
    </DashboardContentRouteSkeleton>
  );
}
