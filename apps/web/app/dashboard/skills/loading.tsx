import {
  DashboardContentRouteSkeleton,
  SkillsRouteSkeleton,
} from "../../_components/route-loading-skeleton";

export default function Loading() {
  return (
    <DashboardContentRouteSkeleton>
      <SkillsRouteSkeleton />
    </DashboardContentRouteSkeleton>
  );
}
