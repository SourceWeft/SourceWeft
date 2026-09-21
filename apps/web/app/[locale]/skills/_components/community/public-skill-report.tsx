import { PublicSkillReportDialog } from "./public-skill-report-dialog";
import type { PublicSkillSlotProps } from "./slot-props";

/**
 * The report button in the attribution section (§17.2). The mailto link
 * beside it stays, for anyone who cannot use the form.
 */
export function PublicSkillReport(props: PublicSkillSlotProps) {
  return <PublicSkillReportDialog {...props} />;
}
