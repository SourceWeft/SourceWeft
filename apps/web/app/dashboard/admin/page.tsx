import { redirect } from "next/navigation";

import { ADMIN_DEFAULT_HREF } from "./_components/admin-sections";

export default function AdminHomePage() {
  redirect(ADMIN_DEFAULT_HREF);
}
