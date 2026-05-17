import {
  ChatRouteSkeleton,
  DashboardContentRouteSkeleton,
} from "../../_components/route-loading-skeleton";

export default function Loading() {
  return (
    <DashboardContentRouteSkeleton>
      <ChatRouteSkeleton />
    </DashboardContentRouteSkeleton>
  );
}
