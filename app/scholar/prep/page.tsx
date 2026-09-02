import { notFound } from "next/navigation";

/** Reserve the retired slug so the dynamic session route cannot claim it. */
export default function RetiredScholarPrepRoute() {
  notFound();
}
