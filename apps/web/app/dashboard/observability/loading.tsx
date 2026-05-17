import {
  DashboardContentRouteSkeleton,
  ObservabilityRouteSkeleton,
} from "../../_components/route-loading-skeleton";

export default function Loading() {
  return (
    <DashboardContentRouteSkeleton>
      <ObservabilityRouteSkeleton />
    </DashboardContentRouteSkeleton>
  );
}
