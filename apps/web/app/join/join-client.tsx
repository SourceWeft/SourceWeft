"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function JoinClient() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/auth/sign-up");
  }, [router]);

  return null;
}
