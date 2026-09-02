"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Flex, Spinner } from "@chakra-ui/react";
import { TeacherToday } from "@/components/TeacherToday";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { withInstitutionScope } from "@/lib/institutionLinks";
import { teacherHomePath } from "@/lib/teacherHome";

/**
 * `/teacher` is the ordinary teacher's Today inbox. Specialty staff keep their
 * role-specific homes (Curriculum for designers, Scholars for operations staff).
 */
export default function TeacherIndexPage() {
  const { user, isLoading } = useCurrentUser();
  const router = useRouter();
  const searchParams = useSearchParams();
  const inst = searchParams.get("inst") ?? "";

  useEffect(() => {
    if (isLoading) return;
    const home = teacherHomePath(
      user?.role,
      user?.hasSchoolOperationsAccess,
    );
    if (home !== "/teacher") {
      router.replace(withInstitutionScope(home, inst));
    }
  }, [isLoading, user, router, inst]);

  if (
    !isLoading &&
    teacherHomePath(user?.role, user?.hasSchoolOperationsAccess) === "/teacher"
  ) {
    return <TeacherToday />;
  }

  return (
    <Flex h="full" align="center" justify="center" bg="gray.50">
      <Spinner size="xl" color="violet.500" />
    </Flex>
  );
}
