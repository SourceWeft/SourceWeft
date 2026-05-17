import {
  DashboardContentRouteSkeleton,
  SkillDetailRouteSkeleton,
} from "../../../_components/route-loading-skeleton";

export default function Loading() {
  return (
    <DashboardContentRouteSkeleton>
      <SkillDetailRouteSkeleton />
    </DashboardContentRouteSkeleton>
  );
}
