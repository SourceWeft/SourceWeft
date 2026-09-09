import { billingUiAvailable } from "../../../lib/billing-edition/catalog";
import {
  BillingRouteSkeleton,
  DashboardContentRouteSkeleton,
} from "../../_components/route-loading-skeleton";

export default function Loading() {
  if (!billingUiAvailable) return null;
  return (
    <DashboardContentRouteSkeleton>
      <BillingRouteSkeleton />
    </DashboardContentRouteSkeleton>
  );
}
